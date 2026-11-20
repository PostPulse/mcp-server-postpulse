import { z } from 'zod';
import { createApiClient } from '../api/client';
import { ApiPost, ApiPostPatch, toPostDetails } from '../api/posts';

// An ISO-8601 timestamp with a time and an explicit offset. The API reads a time without one as UTC, which is not
// what a user in another zone means by "12:00".
const TIMESTAMP_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

const SNIPPET_LENGTH = 80;

export const editPostTool = {
    name: 'edit_post',
    description: 'Change a post that is not published yet (status DRAFT, SCHEDULED, AWAITING_MEDIA or MEDIA_IMPORT_FAILED): its scheduled time, and the text, media or cover of its items. Whatever is not passed stays as it is, ids included, and a draft stays a draft. scheduledTime belongs to the whole post, so a new time moves it on all its accounts. The items of a post are publications[].posts[] in get_post, one or more per account (e.g. one per chat), and their id is postEntryId here; a post with a single item needs no postEntryId. content is the whole new text of an item and replaces the current one; clearContent: true removes the text. mediaPaths replaces all media of an item; removeMedia: true removes them. Replacing or removing media also removes the item\'s cover, unless thumbnailPath sets a new one in the same change. An empty content or mediaPaths is refused, so an empty value never erases anything. The result has post, the post after the edit as get_post shows it, and before, the previous values of what changed, in the form of edit_post inputs: with them, another edit_post puts the previous time, text and media back. Replaced files stay in the media library until delete_media removes them. The text of a WhatsApp broadcast comes from its template and cannot be changed here. Platform settings (title, privacy, publication type) and the accounts or chats of a post are not part of an edit.',
    inputSchema: z.object({
        postId: z.coerce.number().int().positive().describe('The post id from list_posts, get_post or schedule_post'),
        scheduledTime: z.string().optional().describe('New publishing time for the whole post: an ISO-8601 timestamp with Z or an offset (e.g. 2026-11-20T12:00:00Z or 2026-11-20T14:00:00+02:00), in the future'),
        changes: z.array(z.object({
            postEntryId: z.coerce.number().int().positive().optional().describe('The item to change: id of an entry in publications[].posts[] of get_post. Not needed when the post has a single item'),
            content: z.string().optional().describe('The whole new text of the item, replacing the current text. Not empty: clearContent removes the text'),
            // Not coerced: z.coerce.boolean() turns the string "false" into true, which would erase the text.
            clearContent: z.boolean().optional().describe('true removes the item\'s text. Not together with content'),
            mediaPaths: z.array(z.string().min(1).describe('Media key from list_media, upload_media, get_upload_link or media[].key in get_post, not the file name'))
                .optional().describe('New media of the item, replacing all its current media, in this order. Not empty: removeMedia removes the media'),
            removeMedia: z.boolean().optional().describe('true removes all media of the item and its cover. Not together with mediaPaths or thumbnailPath'),
            thumbnailPath: z.string().min(1).optional().describe('Media key of an image to use as the cover of the item\'s video (Instagram Reels use it). thumbnail in get_post is the current one'),
        })).optional().describe('Changes of the post\'s items, at most one per item'),
    }),
};

type Change = {
    postEntryId?: number;
    content?: string;
    clearContent?: boolean;
    mediaPaths?: string[];
    removeMedia?: boolean;
    thumbnailPath?: string;
};

interface EditPostArgs {
    postId: number;
    scheduledTime?: string;
    changes?: Change[];
}

/** The previous values of what one change touched, as an edit_post change that puts them back. */
type Restore = Omit<Change, 'postEntryId'> & { postEntryId: number };

function errorResult(text: string) {
    return { content: [{ type: 'text' as const, text }], isError: true };
}

function apiErrorText(error: any): string {
    return `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}`;
}

/** Why a change cannot be sent as is, or null when it can. */
function invalidChange(c: Change, i: number): string | null {
    const at = `changes[${i}]`;
    if (c.content !== undefined && c.clearContent) {
        return `Error: ${at} has both content and clearContent. content replaces the text, clearContent removes it.`;
    }
    if (c.content !== undefined && c.content.trim() === '') {
        return `Error: ${at}.content is empty. To keep the text, leave content out; to remove it, pass clearContent: true.`;
    }
    if (c.mediaPaths !== undefined && c.removeMedia) {
        return `Error: ${at} has both mediaPaths and removeMedia. mediaPaths replaces the media, removeMedia removes them.`;
    }
    if (c.mediaPaths !== undefined && c.mediaPaths.length === 0) {
        return `Error: ${at}.mediaPaths is empty. To keep the media, leave mediaPaths out; to remove them, pass removeMedia: true.`;
    }
    if (c.removeMedia && c.thumbnailPath !== undefined) {
        return `Error: ${at} has removeMedia and thumbnailPath. A cover belongs to the item's video, which removeMedia removes.`;
    }
    if (c.content === undefined && !c.clearContent && c.mediaPaths === undefined && !c.removeMedia && c.thumbnailPath === undefined) {
        return `Error: ${at} has no content, clearContent, mediaPaths, removeMedia or thumbnailPath, so it changes nothing.`;
    }
    return null;
}

/** One line per item of the post, so the agent can pick the postEntryId without another call. */
function describeItems(post: ApiPost): string {
    return (post.publications ?? []).flatMap((pub) => (pub.posts ?? []).map((p) => {
        const account = pub.accountUsername ? ` @${pub.accountUsername}` : '';
        const chat = p.chatId ? `, chat ${p.chatId}` : '';
        const text = p.content
            ? `, text "${p.content.length > SNIPPET_LENGTH ? `${p.content.slice(0, SNIPPET_LENGTH)}...` : p.content}"`
            : '';
        return `- postEntryId ${p.id}: ${pub.platformName}${account} (accountId ${pub.socialMediaAccountId})${chat}${text}`;
    })).join('\n');
}

type ApiItem = NonNullable<NonNullable<ApiPost['publications']>[number]['posts']>[number];

/**
 * The values an item had before a change, limited to what the change touches. Replacing or removing media drops the
 * cover, so a media change also keeps the old cover. A cover set where there was none has no input that takes it off
 * alone, so such a change leaves nothing to restore.
 */
function restoreOf(change: Change, id: number, item: ApiItem): Restore | null {
    const restore: Restore = { postEntryId: id };
    if (change.content !== undefined || change.clearContent) {
        if (item.content) {
            restore.content = item.content;
        } else {
            restore.clearContent = true;
        }
    }
    const mediaChanged = change.mediaPaths !== undefined || change.removeMedia;
    if (mediaChanged) {
        const keys = (item.media ?? []).map((m) => m.path).filter((k): k is string => Boolean(k));
        if (keys.length > 0) {
            restore.mediaPaths = keys;
        } else {
            restore.removeMedia = true;
        }
    }
    if ((mediaChanged || change.thumbnailPath !== undefined) && item.thumbnail?.path) {
        restore.thumbnailPath = item.thumbnail.path;
    }
    return Object.keys(restore).length > 1 ? restore : null;
}

export async function handleEditPost({ postId, scheduledTime, changes = [] }: EditPostArgs, extra: any) {
    for (const [i, change] of changes.entries()) {
        const invalid = invalidChange(change, i);
        if (invalid) {
            return errorResult(invalid);
        }
    }
    if (scheduledTime === undefined && changes.length === 0) {
        return errorResult('Error: nothing to change. Pass scheduledTime, or changes with content, clearContent, mediaPaths, removeMedia or thumbnailPath.');
    }

    let time: string | undefined;
    if (scheduledTime !== undefined) {
        const parsed = new Date(scheduledTime);
        if (!TIMESTAMP_WITH_OFFSET.test(scheduledTime) || Number.isNaN(parsed.getTime())) {
            return errorResult(`Error: scheduledTime "${scheduledTime}" is not an ISO-8601 timestamp with Z or an offset, e.g. 2026-11-20T12:00:00Z or 2026-11-20T14:00:00+02:00.`);
        }
        time = parsed.toISOString();
    }

    const token = (extra as any)?.authInfo?.token || '';
    const client = createApiClient(token);

    // The post as it is now: it resolves the items and gives the previous values for `before`.
    let current: ApiPost;
    try {
        current = (await client.get<ApiPost>(`/v1/posts/${postId}`)).data;
    } catch (error: any) {
        return errorResult(apiErrorText(error));
    }
    const items = (current.publications ?? []).flatMap((pub) => pub.posts ?? []);

    // A change without postEntryId is for a post with a single item. Writing it to every item of a larger post could
    // replace texts written for each platform, so the agent gets the list of items instead.
    let ids = changes.map((c) => c.postEntryId);
    if (ids.some((id) => id === undefined)) {
        if (items.length !== 1) {
            return errorResult(items.length === 0
                ? `Error: post ${postId} has no items to change.`
                : `Error: post ${postId} has ${items.length} items, so each change needs the postEntryId of the item it is for. Nothing was changed. The items:\n${describeItems(current)}`);
        }
        ids = ids.map((id) => id ?? items[0].id);
    }
    const unknown = ids.find((id) => !items.some((item) => item.id === id));
    if (unknown !== undefined) {
        return errorResult(`Error: post ${postId} has no item with postEntryId ${unknown}. Nothing was changed. The items:\n${describeItems(current)}`);
    }
    const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
    if (repeated !== undefined) {
        return errorResult(`Error: changes has more than one change for postEntryId ${repeated}. Put everything for one item into one change.`);
    }

    const body: ApiPostPatch = {};
    if (time !== undefined) {
        body.scheduledTime = time;
    }
    if (changes.length > 0) {
        body.posts = changes.map((c, i) => ({
            id: ids[i] as number,
            ...(c.content !== undefined && { content: c.content }),
            ...(c.clearContent && { clearContent: true }),
            ...(c.mediaPaths !== undefined && { attachmentPaths: c.mediaPaths }),
            ...(c.removeMedia && { removeAttachments: true }),
            ...(c.thumbnailPath !== undefined && { thumbnailPath: c.thumbnailPath }),
        }));
    }

    const before: { scheduledTime?: string; changes?: Restore[] } = {};
    if (time !== undefined && current.scheduledTime) {
        before.scheduledTime = current.scheduledTime;
    }
    const restores = changes
        .map((c, i) => restoreOf(c, ids[i] as number, items.find((item) => item.id === ids[i]) as ApiItem))
        .filter((r): r is Restore => r !== null);
    if (restores.length > 0) {
        before.changes = restores;
    }

    try {
        const response = await client.patch<ApiPost>(`/v1/posts/${postId}`, body);
        const result = { post: toPostDetails(response.data), before };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
        return errorResult(apiErrorText(error));
    }
}

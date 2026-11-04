import { z } from 'zod';
import { createApiClient } from '../api/client';

export const deletePostTool = {
    name: 'delete_post',
    description: 'Permanently delete a post from PostPulse with its results and metrics, in any status. This cannot be undone: tell the user what will be deleted and get their confirmation first. Pass publicationId to delete only one account\'s publication of the post; deleting the last one deletes the whole post. Media files stay in the library (see delete_media). By default anything already published stays on the social network; deleteFromPlatform: true also deletes it there. That mode is strict and not every platform supports it. Error code platform_deletion_not_supported lists the platforms that cannot delete the post, and nothing has been deleted anywhere: ask the user whether to delete from PostPulse only. Error code platform_deletion_failed means nothing was deleted in PostPulse, posts already removed from other platforms stay removed, and retrying is safe. Error code post_in_progress means the post is being published (or, for one publication, its media is still being imported) and nothing was deleted: try again when that finishes.',
    inputSchema: z.object({
        postId: z.coerce.number().int().positive().describe('The post id from list_posts, get_post or schedule_post'),
        publicationId: z.coerce.number().int().positive().optional().describe('Delete only this publication: publicationId of one account in get_post. Omit to delete the whole post'),
        // Not coerced: z.coerce.boolean() turns the string "false" into true, which would delete the post on the platforms.
        deleteFromPlatform: z.boolean().optional().describe('Also delete the published post on the social network. Default: false'),
    }),
};

export async function handleDeletePost(
    { postId, publicationId, deleteFromPlatform }: { postId: number, publicationId?: number, deleteFromPlatform?: boolean },
    extra: any,
) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);
    const url = publicationId ? `/v1/posts/${postId}/accounts/${publicationId}` : `/v1/posts/${postId}`;
    const deleted = publicationId ? `Publication ${publicationId} of post ${postId}` : `Post ${postId}`;
    const onPlatforms = deleteFromPlatform
        ? 'Anything it had published was also deleted on the platforms.'
        : 'Anything it had published stays on the platforms.';
    try {
        await client.delete(url, { params: { deleteFromPlatform } });
        return { content: [{ type: 'text' as const, text: `${deleted} deleted from PostPulse. ${onPlatforms}` }] };
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}

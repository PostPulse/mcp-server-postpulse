import { z } from 'zod';
import { createApiClient } from '../api/client';
import { UPLOAD_LINK_PAGE } from '../body_limit';
import { logger } from '../logger';

const UPLOAD_LINKS_PATH = '/v1/media/upload-links';

/** `POST /v1/media/upload-links`. */
interface ApiUploadLink {
    id?: string;
    // Carries the token in its fragment, so it is a bearer secret: it goes to the tool result and nowhere else.
    url?: string;
    expiresAt?: string;
}

/** `GET /v1/media/upload-links/{id}`. */
interface ApiUploadLinkStatus {
    expiresAt: string;
    // `path` is the full key schedule_post needs, the same one upload_media returns.
    files: Array<{ path: string; filename?: string; contentType?: string; sizeBytes?: number; status: string }>;
}

export const createUploadLinkTool = {
    name: 'create_upload_link',
    description: `Get a link to an upload page that adds files to the user's PostPulse media library. ${UPLOAD_LINK_PAGE} One link takes several files. A file attached to a chat does not reach this server, but can go through this page. The tool does not wait for the upload: get_upload_link with the uploadLinkId lists the files that have arrived, with their media keys.`,
    inputSchema: z.object({}),
};

export const getUploadLinkTool = {
    name: 'get_upload_link',
    description: 'List the files added through a link from create_upload_link: key, file name, content type, size in bytes and status, plus when the link expires. Pass the keys of CONFIRMED files to schedule_post in mediaPaths. If someone else added the files, first show them the file names and ask them to confirm, because whoever has the link can add files. Files you added yourself need no confirmation.',
    inputSchema: z.object({
        // Strict on purpose: the id goes into the request path and the log, and an agent may paste the link itself, which is a secret.
        uploadLinkId: z.string().uuid().describe('The uploadLinkId returned by create_upload_link, not the link itself'),
    }),
};

function errorResult(text: string) {
    return { content: [{ type: 'text' as const, text }], isError: true };
}

function apiErrorText(error: any): string {
    return `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}`;
}

const SESSION_EXPIRED_TEXT = 'Error: the PostPulse session has expired. Reconnect the PostPulse MCP server and try again.';

/** One line per call. Never add the link, the token or a file name here. */
function logCall(tool: string, extra: any, fields: { outcome: string; status?: number; uploadLinkId?: string; files?: number }) {
    logger.info(
        { tool, ...fields, clientId: extra?.authInfo?.clientId, sub: extra?.authInfo?.extra?.sub },
        `${tool} finished`,
    );
}

function buildLinkText(url: string, expiresAt: string): string {
    return [
        `[Upload files to PostPulse](${url})`,
        url,
        '',
        // Only for a person: an agent that adds the files itself has no one to show this to.
        'For a person opening this link:',
        'Open the link in a browser and add your files; no login is needed. The page shows whose PostPulse library the files go to: continue only if it is yours.',
        // The API sends nanoseconds, which mean nothing to the person reading this.
        `The link takes new files until ${expiresAt.replace(/\.\d+Z$/, 'Z')}. If it has expired, ask me for a new one.`,
        'Do not share it: whoever has this link can add files to your PostPulse library.',
        'When the page says the files are uploaded, tell me you are done, and I will get them.',
    ].join('\n');
}

export async function handleCreateUploadLink(_args: any, extra: any) {
    const token = extra?.authInfo?.token || '';
    const clientId = extra?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);
    const log = (fields: { outcome: string; status?: number; uploadLinkId?: string }) => logCall(createUploadLinkTool.name, extra, fields);

    try {
        const { id, url, expiresAt } = (await client.post<ApiUploadLink>(UPLOAD_LINKS_PATH)).data ?? {};
        if (!id || !url || !expiresAt) {
            log({ outcome: 'empty_link' });
            return errorResult('Error: PostPulse did not return an upload link. Try again later.');
        }
        log({ outcome: 'link_issued', uploadLinkId: id });
        return {
            content: [
                { type: 'text' as const, text: buildLinkText(url, expiresAt) },
                { type: 'text' as const, text: `uploadLinkId: ${id}\nA person who is to add the files needs the link in full, including the part after #, with the text above, and tells you when the page says the files are uploaded. Once the files are added, get_upload_link with this uploadLinkId gives their media keys.` },
            ],
        };
    } catch (error: any) {
        const status = error.response?.status;
        log({ outcome: 'failed', status });
        if (status === 401) {
            return errorResult(SESSION_EXPIRED_TEXT);
        }
        if (status === 429) {
            return errorResult('Error: too many upload links were requested. Wait a while and try again. A link the user already has keeps working until it expires.');
        }
        return errorResult(apiErrorText(error));
    }
}

/** What the agent can do with the list. Files from someone else are where the user gets to see what is about to be posted. */
function buildStatusGuidance({ expiresAt, files }: ApiUploadLinkStatus): string {
    const expired = Date.parse(expiresAt) <= Date.now();
    if (files.length === 0) {
        return expired
            ? 'No files arrived through this link, and it has expired. If the user still wants to upload, call create_upload_link for a new link.'
            : 'No files have arrived through this link yet. A person adding files tells you when the page says they are uploaded.';
    }
    const lines = ['Pass the keys of CONFIRMED files to schedule_post in mediaPaths. If someone else added these files, first show them the file names and ask them to confirm the files are theirs: whoever has the link can add files. Files you added yourself need no confirmation.'];
    if (files.some((file) => file.status === 'PENDING')) {
        lines.push('A PENDING file may still be finishing, so do not use its key yet. Call get_upload_link again when its upload has ended.');
    }
    if (files.some((file) => file.status === 'REJECTED')) {
        lines.push('A REJECTED file was refused and cannot be used. Tell the user.');
    }
    if (expired) {
        lines.push('This link has expired and takes no new files. To add more, call create_upload_link for a new link.');
    }
    return lines.join('\n');
}

export async function handleGetUploadLink({ uploadLinkId }: { uploadLinkId: string }, extra: any) {
    const token = extra?.authInfo?.token || '';
    const clientId = extra?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);
    const log = (fields: { outcome: string; status?: number; files?: number }) => logCall(getUploadLinkTool.name, extra, { uploadLinkId, ...fields });

    try {
        const { data } = await client.get<ApiUploadLinkStatus>(`${UPLOAD_LINKS_PATH}/${uploadLinkId}`);
        const result = {
            expiresAt: data.expiresAt,
            files: data.files.map((file) => ({
                key: file.path,
                filename: file.filename,
                contentType: file.contentType,
                sizeBytes: file.sizeBytes,
                status: file.status,
            })),
        };
        log({ outcome: 'ok', files: result.files.length });
        return {
            content: [
                { type: 'text' as const, text: JSON.stringify(result, null, 2) },
                { type: 'text' as const, text: buildStatusGuidance(data) },
            ],
        };
    } catch (error: any) {
        const status = error.response?.status;
        log({ outcome: 'failed', status });
        if (status === 401) {
            return errorResult(SESSION_EXPIRED_TEXT);
        }
        if (status === 404) {
            return errorResult(`Error: upload link ${uploadLinkId} is unknown. Use the uploadLinkId from create_upload_link in this conversation, or call create_upload_link for a new link. Files uploaded earlier stay in the media library: list_media shows them.`);
        }
        if (status === 429) {
            return errorResult('Error: too many requests. Wait a minute and try again.');
        }
        return errorResult(apiErrorText(error));
    }
}

import { z } from 'zod';
import { createApiClient } from '../api/client';

export const deleteMediaTool = {
    name: 'delete_media',
    description: 'Permanently delete a file from the user\'s PostPulse media library and storage. This cannot be undone: tell the user what will be deleted and get their confirmation first. It changes every post that uses the file: a post that is not published yet is deleted on the accounts where it is left without the media the platform requires or without any content; a published or failed post stays and only loses the attachment. What is already published stays on the social network. Error code post_in_progress means a post using the file is being published and nothing was deleted: try again when publishing finishes.',
    inputSchema: z.object({
        key: z.string().min(1).describe('The media key from list_media, upload_media or media[].key in get_post, not the file name'),
    }),
};

export async function handleDeleteMedia({ key }: { key: string }, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);
    // The API addresses a file by the last segment of its key and adds the caller's own user id itself.
    const id = key.substring(key.lastIndexOf('/') + 1);
    try {
        await client.delete(`/v1/media/${encodeURIComponent(id)}`);
        return { content: [{ type: 'text' as const, text: `Media file ${key} deleted.` }] };
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}

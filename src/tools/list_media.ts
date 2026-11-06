import { z } from 'zod';
import { createApiClient } from '../api/client';
import { MEDIA_GALLERY_URL } from '../body_limit';

export const DEFAULT_PAGE_SIZE = 20;

/** The API signs presigned URLs for every item, so a page stays small. */
export const MAX_PAGE_SIZE = 50;

/** `GET /v1/media` (only the fields this server reads). */
interface ApiMediaPage {
    // `path` is the same key upload_media returns; the API's own `key` is only its last segment.
    items: Array<{ path: string; filename?: string; contentType?: string; sizeBytes?: number }>;
    page: number;
    size: number;
    totalItems: number;
    totalPages: number;
}

export const listMediaTool = {
    name: 'list_media',
    description: `List the files in the user's PostPulse media library, newest first: key, file name, content type and size in bytes. Use it to find a file added at ${MEDIA_GALLERY_URL} by its file name, then pass its key to schedule_post in mediaPaths. The list is paged: if the file is not on this page and page + 1 is less than totalPages, call again with the next page. A file uploaded with mediaData appears here a few minutes later, but its key from upload_media works at once.`,
    inputSchema: z.object({
        // Nullish: some clients send null for omitted optional fields, which z.coerce alone would turn into 0.
        page: z.coerce.number().int().min(0).nullish().describe('Page number, from 0. Default: 0'),
        size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).nullish().describe(`Files per page, 1-${MAX_PAGE_SIZE}. Default: ${DEFAULT_PAGE_SIZE}`),
    }),
};

export async function handleListMedia({ page, size }: { page?: number | null; size?: number | null }, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);
    try {
        const { data } = await client.get<ApiMediaPage>('/v1/media', {
            params: { page: page ?? 0, size: size ?? DEFAULT_PAGE_SIZE },
        });
        // The API's url and thumbnailUrl stay out: they are short-lived presigned links of no use in a chat.
        const result = {
            items: data.items.map((item) => ({
                key: item.path,
                filename: item.filename,
                contentType: item.contentType,
                sizeBytes: item.sizeBytes,
            })),
            page: data.page,
            size: data.size,
            totalItems: data.totalItems,
            totalPages: data.totalPages,
        };
        const content = [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }];
        if (data.totalItems === 0) {
            content.push({ type: 'text' as const, text: `The media library is empty. Files are added at ${MEDIA_GALLERY_URL} or through create_upload_link.` });
        }
        return { content };
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}

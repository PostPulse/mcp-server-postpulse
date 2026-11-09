import { z } from 'zod';
import { createApiClient } from '../api/client';
import { ApiAccount, unknownAccountMessage } from '../api/accounts';

const accountIdSchema = z.coerce.number().int().positive().describe('The ID of a WHATSAPP account from list_accounts');

export const listWhatsAppTemplatesTool = {
    name: 'list_whatsapp_templates',
    description: 'List the approved message templates of a WhatsApp account (platform WHATSAPP in list_accounts). A WhatsApp post sends one template, so pick it here before schedule_post and pass its name and language as templateName and templateLanguage. Fill the template\'s variables in schedule_post: bodyParameters needs a value for every key in bodyParameterKeys ("1", "2", ... when parameterFormat is POSITIONAL, the variable names when it is NAMED); headerParameter only when headerParameterKey is set (up to 60 characters); buttonParameters maps the index of each button with dynamicUrl true to the end of its URL. A headerFormat of IMAGE or VIDEO needs exactly one media key of that type in mediaPaths. Templates with supported false cannot be sent (see unsupportedReason). Templates are created in WhatsApp Manager, not in PostPulse.',
    inputSchema: z.object({ accountId: accountIdSchema }),
};

export const listWhatsAppContactListsTool = {
    name: 'list_whatsapp_contact_lists',
    description: 'List the contact lists of a WhatsApp account (platform WHATSAPP in list_accounts): id, name and contactCount. A WhatsApp post is a broadcast to one list: pass its id as contactListId in schedule_post. Contact lists are created and filled on the PostPulse website.',
    inputSchema: z.object({ accountId: accountIdSchema }),
};

export const getWhatsAppDeliveryTool = {
    name: 'get_whatsapp_delivery',
    description: 'Show how a WhatsApp broadcast went: how many messages are pending, accepted, sent, delivered, read, failed, opted out or cancelled, and the most frequent errors. postId is the id of the post inside the publication (publications[].posts[].id from get_post), not the id of the scheduled post itself. The counts keep changing while WhatsApp reports statuses.',
    inputSchema: z.object({
        accountId: accountIdSchema,
        postId: z.coerce.number().int().positive().describe('publications[].posts[].id of the WhatsApp publication from get_post'),
    }),
};

export async function handleListWhatsAppTemplates({ accountId }: { accountId: number }, extra: any) {
    return getForWhatsAppAccount(accountId, 'templates', extra);
}

export async function handleListWhatsAppContactLists({ accountId }: { accountId: number }, extra: any) {
    return getForWhatsAppAccount(accountId, 'contact-lists', extra);
}

export async function handleGetWhatsAppDelivery({ accountId, postId }: { accountId: number; postId: number }, extra: any) {
    return getForWhatsAppAccount(accountId, `posts/${postId}/delivery`, extra);
}

/** GET /v1/accounts/{accountId}/whatsapp/{path} once the account is checked to be one of the user's WhatsApp accounts. */
async function getForWhatsAppAccount(accountId: number, path: string, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);
    try {
        const accounts = (await client.get<ApiAccount[]>('/v1/accounts')).data;
        const account = accounts.find((acc) => acc.id === accountId);
        if (!account) {
            return { content: [{ type: 'text' as const, text: unknownAccountMessage(accountId, accounts) }], isError: true };
        }
        if (account.platform !== 'WHATSAPP') {
            return {
                content: [{ type: 'text' as const, text: `Error: account ${accountId} is ${account.platform}, not a WHATSAPP account.` }],
                isError: true,
            };
        }
        const response = await client.get(`/v1/accounts/${accountId}/whatsapp/${path}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(response.data, null, 2) }] };
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}

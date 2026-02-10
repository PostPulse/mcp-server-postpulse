import axios, { AxiosInstance } from 'axios';
import { config } from '../config';

/**
 * Creates an Axios instance for the PostPulse API.
 * The user's Bearer token is passed through from the authenticated MCP request.
 */
export function createApiClient(bearerToken: string): AxiosInstance {
    return axios.create({
        baseURL: config.POSTPULSE_API_URL,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${bearerToken}`,
            'x-api-key': config.POSTPULSE_CLIENT_ID,
        },
    });
}

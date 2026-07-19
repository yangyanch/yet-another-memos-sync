import { requestUrl, RequestUrlResponse } from 'obsidian';
import { moment } from 'obsidian'; // 引入 moment 用于时间格式转换
import { APIClient, ListMemosOptions, ListMemosPage, Memo } from '../types';
import { t } from '../i18n/translationManager';

interface ListMemosResponse {
    memos?: Memo[];
    nextPageToken?: string;
}

export class MemosAPIClient implements APIClient {
    private baseURL: string;
    private token: string;

    public getBaseURL(): string { return this.baseURL; }
    public getToken(): string { return this.token; }

    constructor(baseURL: string, token: string) {
        this.baseURL = baseURL.replace(/\/$/, '');
        this.token = token;
    }

    async listMemos(opts: ListMemosOptions = {}): Promise<ListMemosPage> {
        const params = new URLSearchParams();
        params.set('pageSize', String(opts.pageSize ?? 100));
        if (opts.pageToken) params.set('pageToken', opts.pageToken);
        if (opts.filter) params.set('filter', opts.filter);

        const url = `${this.baseURL}/api/v1/memos?${params.toString()}`;
        let response: RequestUrlResponse;
        try {
            response = await requestUrl({
                url,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Accept': 'application/json',
                },
                throw: false,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${t.t('NETWORK_ERROR')} ${url}. ${message}`);
        }

        if (response.status < 200 || response.status >= 300) {
            const body = response.text || '';
            console.error(`API request failed: ${response.status}`, body);
            const summary = body.replace(/\s+/g, ' ').trim().slice(0, 200);
            const detail = summary ? ` ${summary}${body.length > 200 ? '…' : ''}` : '';
            throw new Error(`${t.t('FETCH_MEMOS_ERROR')}: HTTP ${response.status}${detail}`);
        }

        const data = response.json as ListMemosResponse;
        return {
            memos: data.memos ?? [],
            nextPageToken: data.nextPageToken ?? '',
        };
    }

    /**
     * 创建新 Memo
     * @param content 内容
     * @param createdTs Unix 时间戳 (秒)。如果提供，将转换为 RFC3339 格式的 createTime。
     */
    async createMemo(content: string, createdTs?: number): Promise<Memo> {
        const url = `${this.baseURL}/api/v1/memos`;
        const body: any = { content: content };

        if (createdTs !== undefined && createdTs !== null) {
            // 将 Unix 时间戳转换为 RFC3339 格式字符串，并使用 createTime 字段
            body.createTime = moment.unix(createdTs).utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
        }

        let response: RequestUrlResponse;
        try {
            response = await requestUrl({
                url,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                throw: false,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Network error creating memo: ${message}`);
        }

        if (response.status < 200 || response.status >= 300) {
            const errBody = response.text || '';
            console.error(`Create memo failed: ${response.status}`, errBody);
            throw new Error(`Failed to create memo: HTTP ${response.status}`);
        }

        return response.json as Memo;
    }

    /**
     * 更新现有 Memo
     * @param id Memo ID
     * @param content 新内容
     * @param createdTs 可选，Unix 时间戳 (秒)。如果提供，将转换为 RFC3339 格式的 createTime。
     */
    async updateMemo(id: number | string, content: string, createdTs?: number): Promise<Memo> {
        const url = `${this.baseURL}/api/v1/memos/${id}`;
        const body: any = { content: content };
        
        if (createdTs !== undefined && createdTs !== null) {
            // 将 Unix 时间戳转换为 RFC3339 格式字符串，并使用 createTime 字段
            body.createTime = moment.unix(createdTs).utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
            // 注意：更新 createTime 可能需要 updateMask 包含 "createTime"，具体取决于 API 版本实现。
            // 如果更新不生效，可能需要添加: body.updateMask = "content,createTime";
        }

        let response: RequestUrlResponse;
        try {
            response = await requestUrl({
                url,
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                throw: false,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Network error updating memo ${id}: ${message}`);
        }

        if (response.status < 200 || response.status >= 300) {
            const errBody = response.text || '';
            console.error(`Update memo failed: ${response.status}`, errBody);
            throw new Error(`Failed to update memo ${id}: HTTP ${response.status}`);
        }

        return response.json as Memo;
    }

    async deleteMemo(id: number | string): Promise<void> {
        const url = `${this.baseURL}/api/v1/memos/${id}`;
        let response: RequestUrlResponse;
        try {
            response = await requestUrl({
                url,
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                },
                throw: false,
            });
        } catch (error) {
            const message = error instanceof Error ? String(error) : 'Unknown error';
            throw new Error(`Network error deleting memo ${id}: ${message}`);
        }

        if (response.status < 200 || response.status >= 300) {
            const errBody = response.text || '';
            console.error(`Delete memo failed: ${response.status}`, errBody);
            throw new Error(`Failed to delete memo ${id}: HTTP ${response.status}`);
        }
    }
}

import { requestUrl, RequestUrlResponse } from 'obsidian';
import { APIClient, ListMemosOptions, ListMemosPage, Memo } from '../types';
import { t } from '../i18n/translationManager';

interface ListMemosResponse {
    memos?: Memo[];
    nextPageToken?: string;
}

/**
 * HTTP client for the memos /api/v1/memos endpoint.
 * Supports CEL filter and proper page-token pagination.
 * Uses Obsidian's requestUrl so it works on both desktop and mobile.
 */
export class MemosAPIClient implements APIClient {
    private baseURL: string;
    private token: string;

    // 暴露 baseURL 和 token 供 Paginator 等其他模块使用（如下载图片）
    public getBaseURL(): string {
        return this.baseURL;
    }

    public getToken(): string {
        return this.token;
    }

    constructor(baseURL: string, token: string) {
        this.baseURL = baseURL.replace(/\/$/, '');
        this.token = token;
    }

    /**
     * 获取 Memos 列表
     */
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
     * @param createdTs 可选，Unix 时间戳 (秒)。如果未提供，服务器使用当前时间。
     */
    async createMemo(content: string, createdTs?: number): Promise<Memo> {
        const url = `${this.baseURL}/api/v1/memos`;
        
        // 构造请求体
        const body: any = {
            content: content,
            // visibility: 'PRIVATE', // 可选，根据需要设置
        };
        
        // 如果提供了时间戳，添加到请求体 (Memos v0.22+ API 字段通常为 createdTs)
        if (createdTs) {
            body.createdTs = createdTs;
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
     * @param id Memo ID (数字或字符串)
     * @param content 新内容
     */
    async updateMemo(id: number | string, content: string): Promise<Memo> {
        const url = `${this.baseURL}/api/v1/memos/${id}`;

        let response: RequestUrlResponse;
        try {
            response = await requestUrl({
                url,
                method: 'PATCH', // 或 'PUT'，取决于 Memos 版本，v0.22+ 通常支持 PATCH
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    content: content,
                }),
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

    /**
     * 删除 Memo
     * @param id Memo ID
     */
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
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Network error deleting memo ${id}: ${message}`);
        }

        if (response.status < 200 || response.status >= 300) {
            const errBody = response.text || '';
            console.error(`Delete memo failed: ${response.status}`, errBody);
            throw new Error(`Failed to delete memo ${id}: HTTP ${response.status}`);
        }
    }
}

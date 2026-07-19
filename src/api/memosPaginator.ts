import { moment, App, requestUrl } from 'obsidian';
import { Memo, MemosPaginator, APIClient } from '../types';
import { transformMemoToMarkdown } from '../utils/memoTransformer';
import { getSafeFilename, extractAttachmentUid } from '../utils/resourceUtils'; // 引入公共逻辑

const PAGE_SIZE = 200;
const MAX_PAGES = 200;

function buildFilter(lastTimestamp: number, cutoffTimestamp: number): string {
    const since = Math.max(lastTimestamp, cutoffTimestamp);
    return since > 0 ? `created_ts > ${since}` : '';
}

function extractTimestamp(memo: Memo): number | null {
    if (typeof memo.timestamp === 'number') return memo.timestamp;
    if (typeof memo.createdTs === 'number') return memo.createdTs;
    if (memo.createTime) {
        const m = moment(memo.createTime);
        return m.isValid() ? m.unix() : null;
    }
    if (memo.createdAt) {
        const m = moment(memo.createdAt);
        return m.isValid() ? m.unix() : null;
    }
    return null;
}

export class SimpleMemosPaginator implements MemosPaginator {
    constructor(
        private client: APIClient,
        private app: App,
        private lastTime: string,
        private useCalloutFormat: boolean,
        private useListCalloutFormat: boolean,
        private skipImages: boolean,
        private syncDaysLimit: number,
        private assetPath: string,
        private showEmoji: boolean,
        private tagMode: 'none' | 'smart' | 'always',
        private customTag: string,
    ) {}

    private async saveImage(url: string, filename: string): Promise<void> {
        const vault = this.app.vault;
        const fullPath = `${this.assetPath}/${filename}`;

        if (await vault.adapter.exists(fullPath)) return;

        try {
            const folder = vault.getAbstractFileByPath(this.assetPath);
            if (!folder) await vault.createFolder(this.assetPath);

            // 必须携带 Authorization: Bearer {token} 头
            const response = await requestUrl({
                url,
                method: 'GET',
                headers: { Authorization: `Bearer ${(this.client as any).token}` },
                arrayBuffer: true,
            } as any);

            await vault.adapter.writeBinary(fullPath, response.arrayBuffer);
            console.log(`Memos Sync: 下载图片成功 -> ${filename}`);
        } catch (e) {
            console.error(`Memos Sync: 下载图片失败 ${url}`, e);
        }
    }

    async foreach(handler: (dayData: [string, Record<string, string>]) => Promise<void>): Promise<string> {
        const dailyMemosByDay: Record<string, Record<string, string>> = {};
        let latestTimestamp = '';

        const cutoffTimestamp = this.syncDaysLimit > 0
            ? moment().subtract(this.syncDaysLimit, 'days').startOf('day').unix()
            : 0;
        const lastTimestamp = this.lastTime ? parseInt(this.lastTime) : 0;

        const filter = buildFilter(lastTimestamp, cutoffTimestamp);

        let pageToken = '';
        let pages = 0;
        let exhausted = false;

        while (!exhausted) {
            const page = await this.client.listMemos({ pageSize: PAGE_SIZE, pageToken, filter });
            pages += 1;

            for (const memo of page.memos) {
                try {
                    const timestamp = extractTimestamp(memo);
                    if (timestamp === null) continue;
                    if (cutoffTimestamp > 0 && timestamp < cutoffTimestamp) continue;
                    if (lastTimestamp > 0 && timestamp <= lastTimestamp) continue;

                    const resources = memo.attachments || memo.resourceList || memo.resources || [];
                    
                    // --- 图片下载逻辑 (精简后) ---
                    if (!this.skipImages && resources.length > 0) {
                        for (const res of resources) {
                            const filename = getSafeFilename(res); // 使用公共函数
                            let imageUrl = res.externalLink || null;

                            // 本地存储：按官方模板 /file/attachments/:uid/:filename 拼接
                            if (!imageUrl && res.name) {
                                const uid = extractAttachmentUid(res.name); // 使用公共函数
                                if (uid) imageUrl = `${(this.client as any).baseURL}/file/attachments/${uid}/${filename}`;
                            }
                            
                            // 兼容旧版
                            if (!imageUrl && res.id) imageUrl = `${(this.client as any).baseURL}/file/${res.id}`;

                            if (imageUrl) await this.saveImage(imageUrl, filename);
                        }
                    }

                    const dailyMemo = transformMemoToMarkdown(
                        { timestamp, content: memo.content, resources },
                        this.useCalloutFormat, this.useListCalloutFormat, this.skipImages,
                        this.showEmoji, this.tagMode, this.customTag,
                    );

                    if (!dailyMemosByDay[dailyMemo.date]) dailyMemosByDay[dailyMemo.date] = {};
                    dailyMemosByDay[dailyMemo.date][dailyMemo.timestamp] = dailyMemo.content;

                    if (!latestTimestamp || timestamp > parseInt(latestTimestamp)) latestTimestamp = String(timestamp);
                } catch (error) {
                    console.warn('Failed to process memo:', memo, error);
                }
            }

            if (!page.nextPageToken) exhausted = true;
            else if (pages > MAX_PAGES) exhausted = true;
            else pageToken = page.nextPageToken;
        }

        for (const [date, dayMemos] of Object.entries(dailyMemosByDay)) {
            await handler([date, dayMemos]);
        }

        return latestTimestamp || this.lastTime;
    }
}

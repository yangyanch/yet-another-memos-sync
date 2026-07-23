// src/services/dailyNoteManager.ts
import { App, TFile, moment, requestUrl } from 'obsidian';
import { getDailyNote, createDailyNote, getAllDailyNotes } from 'obsidian-daily-notes-interface';
type MomentInstance = ReturnType<typeof moment>;
import { MemosAPIClient } from '../api/memosClient';
import { MemosProfile, MemosSettings, Memo, MemoSyncState, SyncStateStore } from '../types';
import { transformMemoToMarkdown } from '../utils/memoTransformer';
import { getSafeFilename, extractAttachmentUid } from '../utils/resourceUtils';

export type SyncMode = 'smart' | 'incremental' | 'force';

function simpleHash(str: string): string {
    let hash = 0;
    if (str.length === 0) return hash.toString();
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString();
}

function extractMemoId(memo: any): string | undefined {
    if (!memo) return undefined;
    if (memo.name) {
        const parts = memo.name.split('/');
        if (parts.length > 1) return parts[1];
        return memo.name;
    }
    if (memo.uid) return memo.uid;
    if (memo.id) return String(memo.id);
    return undefined;
}

function extractMemoTimestamp(memo: any): number {
    if (typeof memo.createdTs === 'number') return memo.createdTs;
    if (typeof memo.timestamp === 'number') return memo.timestamp;
    if (memo.createTime) {
        const m = moment(memo.createTime as string);
        return m.isValid() ? m.unix() : 0;
    }
    if (memo.createdAt) {
        const m = moment(memo.createdAt as string);
        return m.isValid() ? m.unix() : 0;
    }
    return 0;
}

class ObsidianLineItem {
    id: string | null = null;
    time: string;
    content: string;
    rawLine: string;
    lineIndex: number = -1;
    endLineIndex: number = -1;

    constructor(line: string, index: number, defaultTime: string) {
        this.rawLine = line;
        this.lineIndex = index;
        this.endLineIndex = index;
        this.time = defaultTime;
        this.parseLine(line);
    }

    private parseLine(line: string) {
        let cleanLine = line.replace(/^\s*[-*]\s*/, '');
        const idMatch = cleanLine.match(/\s?\^([a-zA-Z0-9_-]+)\s*$/);
        if (idMatch) {
            this.id = idMatch[1];
            cleanLine = cleanLine.replace(idMatch[0], '').trim();
        }
        const timeMatch = cleanLine.match(/^(\S*\s+)?(\d{1,2}:\d{2})/);
        if (timeMatch) {
            this.time = timeMatch[2];
            const remaining = cleanLine.slice(timeMatch[0].length).trim();
            this.content = remaining;
        } else {
            this.content = cleanLine;
        }
    }
}

export class DailyNoteManager {
    constructor(
        private app: App,
        private settings: MemosSettings,
        private state: SyncStateStore,
    ) {}

    updateSettings(settings: MemosSettings): void {
        this.settings = settings;
    }

    // --- [新增] 调试日志辅助方法 ---
    private debugLog(...args: any[]): void {
        if (this.settings.debugMode) {
            console.log(`[Memos Sync][${moment().format('HH:mm:ss')}]`, ...args);
        }
    }

    private getCreatedTsFromItem(item: ObsidianLineItem, day: MomentInstance): number {
        const timeParts = item.time.split(':');
        const hour = parseInt(timeParts[0]);
        const minute = parseInt(timeParts[1]);
        if (!isNaN(hour) && !isNaN(minute)) {
            return day.clone().hour(hour).minute(minute).second(0).unix();
        }
        return day.startOf('day').unix();
    }

    private sanitizeContentForMemos(content: string): string {
        let clean = content.replace(/!\[\[[^\]]+\]\]/g, '');
        clean = clean.replace(/\s\^[a-zA-Z0-9_-]+$/gm, '');
        return clean.trim();
    }

    async syncAll(mode: SyncMode): Promise<void> {
        const profiles = (this.settings.profiles || []).filter(p => p.enabled && p.apiUrl && p.apiToken);
        if (profiles.length === 0) return;
        
        this.debugLog(`Starting sync for ${profiles.length} profiles.`);
        
        for (const profile of profiles) {
            try {
                await this.syncProfile(profile, mode);
            } catch (error) {
                console.error(`Sync failed for profile "${profile.name}":`, error);
                throw error;
            }
        }
        await this.state.markSyncedToday();
        this.debugLog(`All profiles synced.`);
    }

    private async syncProfile(profile: MemosProfile, mode: SyncMode): Promise<void> {
        const client = new MemosAPIClient(profile.apiUrl, profile.apiToken);
        const daysLimit = profile.syncDaysLimit || 30;
        
        this.debugLog(`Syncing profile "${profile.name}" (Limit: ${daysLimit} days)`);

        for (let i = 0; i <= daysLimit; i++) {
            const day = moment().subtract(i, 'days');
            const dateStr = day.format('YYYY-MM-DD');
            try {
                await this.syncDay(client, day, dateStr, profile);
            } catch (err) {
                console.error(`Error syncing ${dateStr}:`, err);
            }
        }
        this.gcMemoStates(profile.id, daysLimit);
        const now = moment().unix();
        await this.state.setLastSync(profile.id, String(now));
    }

    private async gcMemoStates(profileId: string, limitDays: number) {
        // GC logic can be added here if needed in future
    }

    // --- [修改] 附件保存逻辑：扁平化 + 日期目录 ---
    private async saveImage(client: MemosAPIClient, url: string, filename: string, day: MomentInstance): Promise<void> {
        const vault = this.app.vault;
        const baseFolder = this.settings.attachmentFolderPath || 'assets/memos';
        const dateFolder = day.format('YYYY-MM-DD'); // 生成日期文件夹名
        
        // 最终路径：assets/memos/2023-10-01/image.png
        const fullPath = `${baseFolder}/${dateFolder}/${filename}`;

        if (await vault.adapter.exists(fullPath)) return;

        try {
            // 确保目录存在
            if (!(await vault.adapter.exists(`${baseFolder}/${dateFolder}`))) {
                await vault.adapter.mkdir(`${baseFolder}/${dateFolder}`);
            }

            const response = await requestUrl({
                url,
                method: 'GET',
                headers: { Authorization: `Bearer ${client.getToken()}` },
                arrayBuffer: true
            } as any);
            
            await vault.adapter.writeBinary(fullPath, response.arrayBuffer);
            this.debugLog(`Image saved: ${fullPath}`);
        } catch (e) {
            console.error(`Memos Sync: Failed to download image ${url}`, e);
        }
    }

    private async processResources(client: MemosAPIClient, memo: Memo, day: MomentInstance): Promise<void> {
        if (this.settings.skipImages) return;
        const resources = memo.attachments || memo.resourceList || memo.resources || [];
        for (const res of resources) {
            const filename = getSafeFilename(res);
            let imageUrl = res.externalLink || null;
            if (!imageUrl && res.name) {
                const uid = extractAttachmentUid(res.name);
                if (uid) imageUrl = `${client.getBaseURL()}/file/attachments/${uid}/${filename}`;
            }
            if (!imageUrl && res.id) imageUrl = `${client.getBaseURL()}/file/${res.id}`;
            if (imageUrl) await this.saveImage(client, imageUrl, filename, day);
        }
    }

    private async syncDay(client: MemosAPIClient, day: MomentInstance, dateStr: string, profile: MemosProfile) {
        const startTs = day.startOf('day').unix();
        const endTs = day.endOf('day').unix();
        const filter = `created_ts >= ${startTs} && created_ts < ${endTs}`;
        
        this.debugLog(`Fetching memos for ${dateStr}...`);
        const page = await client.listMemos({ filter });
        let todayMemos = page.memos;

                // --- [新增] 标签排除逻辑 ---
        const excludeTags = this.settings.excludeTags || [];
        if (excludeTags.length > 0) {
            const originalCount = todayMemos.length;
            todayMemos = todayMemos.filter(memo => {
                // 使用 find 获取匹配的标签对象，以便在日志中输出
                const matchedTag = excludeTags.find(tag => memo.content.includes(tag));
                if (matchedTag) {
                    this.debugLog(`Memo ${extractMemoId(memo)} excluded by tag: ${matchedTag}`);
                    return false;
                }
                return true;
            });
            if (todayMemos.length < originalCount) {
                this.debugLog(`Filtered out ${originalCount - todayMemos.length} memos by tags.`);
            }
        }

        const memosMap: Map<string, Memo> = new Map();
        for (const m of todayMemos) {
            const mId = extractMemoId(m);
            if (mId) memosMap.set(mId, m);
        }

        const existingNote = getDailyNote(day, getAllDailyNotes());
        const isFileExists = existingNote instanceof TFile;
        const lastSyncTime = parseInt(this.state.getLastSync(profile.id) || '0');
        const isFirstSync = (lastSyncTime === 0);

        // ... (保持文件缺失逻辑不变) ...
        if (!isFileExists) {
            let hasNewMemos = false;
            if (isFirstSync) {
                hasNewMemos = memosMap.size > 0;
            } else {
                for (const memo of memosMap.values()) {
                    if (extractMemoTimestamp(memo) > lastSyncTime) {
                        hasNewMemos = true;
                        break;
                    }
                }
            }

            if (hasNewMemos) {
                console.log(`Detected new memos on server for ${dateStr}, recreating daily note.`);
                if (!this.settings.createMissingDailyNotes) return;
            } else {
                if (!isFirstSync && this.settings.enableMirrorDelete) {
                    console.log(`Daily note deleted for ${dateStr}, mirroring delete to Memos...`);
                    for (const [id, memo] of memosMap) {
                        await client.deleteMemo(id);
                        await this.state.deleteMemoSyncState(profile.id, id);
                    }
                } else {
                    console.log(`Daily note missing for ${dateStr}, but mirror delete is disabled or first sync. Skipping.`);
                }
                return;
            }
        }

        const dailyNote = await this.getOrCreateDailyNote(day);
        if (!dailyNote) return;

        let content = await this.app.vault.read(dailyNote);
        const header = profile.dailyMemoHeader || '## 📓 Memos';
        const headerRegex = new RegExp(`^${this.escapeRegex(header)}`, 'm');
        const headerMatch = content.match(headerRegex);
        
        if (!headerMatch) return;

        const headerIndex = content.indexOf(headerMatch[0]);
        const nextHeaderMatch = content.slice(headerIndex + 1).match(/\n## /);
        const memosSectionEnd = nextHeaderMatch ? headerIndex + 1 + (nextHeaderMatch.index ?? 0) : content.length;
        const lines = content.substring(headerIndex, memosSectionEnd).split('\n');

        // ... (解析逻辑保持不变) ...
        const obsidianItems: Map<string, ObsidianLineItem> = new Map();
        const newItems: ObsidianLineItem[] = [];
        const defaultTime = moment().format('HH:mm');
        let currentItem: ObsidianLineItem | null = null;

        const flushItem = () => {
            if (currentItem) {
                if (!currentItem.id && currentItem.content) {
                    const idMatch = currentItem.content.match(/\s?\^([a-zA-Z0-9_-]+)\s*$/);
                    if (idMatch) {
                        currentItem.id = idMatch[1];
                        currentItem.content = currentItem.content.replace(idMatch[0], '').trim();
                    }
                }
                if (currentItem.id) {
                    obsidianItems.set(currentItem.id, currentItem);
                } else if (currentItem.rawLine.trim().length > 0) {
                    newItems.push(currentItem);
                }
            }
            currentItem = null;
        };

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            const isNewItem = /^\s*[-*]\s+\d{1,2}:\d{2}/.test(line);
            if (isNewItem) {
                flushItem();
                currentItem = new ObsidianLineItem(line, i, defaultTime);
            } else if (currentItem) {
                currentItem.endLineIndex = i;
                currentItem.content += '\n' + line;
            }
        }
        flushItem();

        let needsUpdate = false;
        const processedMemoIds: Set<string> = new Set();

        // --- 已存在项目的同步逻辑 ---
        for (const item of obsidianItems.values()) {
            if (!item.id) continue;
            processedMemoIds.add(item.id);
            const remoteMemo = memosMap.get(item.id);
            const localContentClean = this.cleanContent(item.content);
            const localHash = simpleHash(localContentClean);
            
            // [调试日志] 打印哈希值
            this.debugLog(`Comparing Item ${item.id}: LocalHash=${localHash}`);

            const baseState = this.state.getMemoSyncState(profile.id, item.id);
            const baseHash = baseState?.hash;

            if (remoteMemo) {
                const remoteContentClean = this.cleanContent(remoteMemo.content);
                const remoteHash = simpleHash(remoteContentClean);
                this.debugLog(` -> RemoteHash=${remoteHash}, BaseHash=${baseHash || 'N/A'}`);

                const effectiveBaseHash = baseHash || remoteHash;
                const isLocalChanged = (localHash !== effectiveBaseHash);
                const isRemoteChanged = (remoteHash !== effectiveBaseHash);

                if (isLocalChanged && isRemoteChanged) {
                    this.debugLog(`Conflict detected for ${item.id}. Resolving...`);
                    const remoteTime = extractMemoTimestamp(remoteMemo);
                    const localTime = Math.floor(dailyNote.stat.mtime / 1000);
                    
                    if (remoteTime >= localTime) {
                        await this.updateLocalLine(lines, item, remoteMemo);
                        await this.state.setMemoSyncState(profile.id, item.id, { hash: remoteHash, time: moment().unix() });
                    } else {
                        const safeContent = this.sanitizeContentForMemos(item.content);
                        const newTs = this.getCreatedTsFromItem(item, day);
                        await client.updateMemo(item.id, safeContent, newTs);
                        await this.state.setMemoSyncState(profile.id, item.id, { hash: localHash, time: moment().unix() });
                    }
                    needsUpdate = true;
                } else if (isLocalChanged) {
                    this.debugLog(`Local change detected: ${item.id}`);
                    const safeContent = this.sanitizeContentForMemos(item.content);
                    const newTs = this.getCreatedTsFromItem(item, day);
                    await client.updateMemo(item.id, safeContent, newTs);
                    await this.state.setMemoSyncState(profile.id, item.id, { hash: localHash, time: moment().unix() });
                } else if (isRemoteChanged) {
                    this.debugLog(`Remote change detected: ${item.id}`);
                    await this.updateLocalLine(lines, item, remoteMemo);
                    await this.state.setMemoSyncState(profile.id, item.id, { hash: remoteHash, time: moment().unix() });
                    needsUpdate = true;
                }
            } else {
                if (baseState) {
                    if (this.settings.enableMirrorDelete) {
                        this.debugLog(`Deleted on server: ${item.id}, mirroring delete locally.`);
                        this.deleteLocalLine(lines, item);
                        await this.state.deleteMemoSyncState(profile.id, item.id);
                        needsUpdate = true;
                    }
                }
            }
        }

        // ... (新增项目逻辑保持不变) ...
        for (const item of newItems) {
            const timeParts = item.time.split(':');
            const hour = parseInt(timeParts[0]);
            const minute = parseInt(timeParts[1]);
            if (isNaN(hour) || isNaN(minute)) continue;
            const createdTs = day.clone().hour(hour).minute(minute).second(0).unix();
            const safeContent = this.sanitizeContentForMemos(item.content);
            const newMemo = await client.createMemo(safeContent, createdTs);
            const newId = extractMemoId(newMemo);
            if (newId) {
                this.debugLog(`Created new memo ${newId} from local item.`);
                this.updateLocalLineId(lines, item, newId);
                const newHash = simpleHash(this.cleanContent(item.content));
                await this.state.setMemoSyncState(profile.id, newId, { hash: newHash, time: moment().unix() });
                needsUpdate = true;
            }
        }

        // --- 服务端新项目的同步逻辑 ---
        for (const [id, memo] of memosMap) {
            if (processedMemoIds.has(id)) continue;
            const baseState = this.state.getMemoSyncState(profile.id, id);
            
            if (baseState) {
                if (this.settings.enableMirrorDelete) {
                    this.debugLog(`Deleted locally: ${id}, mirroring delete to Memos.`);
                    await client.deleteMemo(id);
                    await this.state.deleteMemoSyncState(profile.id, id);
                }
            } else {
                this.debugLog(`Pulling new memo ${id}`);
                await this.processResources(client, memo, day); // 传入 day 参数用于附件路径
                const resources = memo.attachments || memo.resourceList || memo.resources || [];
                const dailyMemoFormat = transformMemoToMarkdown(
                    { timestamp: extractMemoTimestamp(memo), content: memo.content, resources: resources || [] },
                    this.settings.useCalloutFormat,
                    this.settings.useListCalloutFormat,
                    this.settings.skipImages,
                    this.settings.showEmoji,
                    this.settings.tagMode,
                    this.settings.customTag
                );
                let finalText = dailyMemoFormat.content.trim();
                let contentLines = finalText.split('\n');
                contentLines[contentLines.length - 1] = `${contentLines[contentLines.length - 1]} ^${id}`;
                lines.push(...contentLines);
                const newHash = simpleHash(this.cleanContent(memo.content));
                await this.state.setMemoSyncState(profile.id, id, { hash: newHash, time: moment().unix() });
                needsUpdate = true;
            }
        }

        if (needsUpdate) {
            const cleanLines = lines.filter(l => l !== null);
            const newSectionContent = cleanLines.join('\n');
            const newFileContent = content.substring(0, headerIndex) + newSectionContent + content.substring(memosSectionEnd);
            await this.app.vault.modify(dailyNote, newFileContent);
            this.debugLog(`Daily note ${dateStr} updated.`);
        }
    }

    private async updateLocalLine(lines: string[], item: ObsidianLineItem, memo: Memo) {
        const resources = memo.attachments || memo.resourceList || memo.resources || [];
        const formatted = transformMemoToMarkdown(
            { timestamp: extractMemoTimestamp(memo), content: memo.content, resources: resources || [] },
            this.settings.useCalloutFormat,
            this.settings.useListCalloutFormat,
            this.settings.skipImages,
            this.settings.showEmoji,
            this.settings.tagMode,
            this.settings.customTag
        );
        let finalText = formatted.content.trim();
        let contentLines = finalText.split('\n');
        contentLines[contentLines.length - 1] = `${contentLines[contentLines.length - 1]} ^${item.id}`;
        for (let i = item.lineIndex; i <= item.endLineIndex; i++) {
            lines[i] = '';
        }
        lines[item.lineIndex] = contentLines.join('\n');
    }

    private deleteLocalLine(lines: string[], item: ObsidianLineItem) {
        for (let i = item.lineIndex; i <= item.endLineIndex; i++) {
            lines[i] = '';
        }
    }

    private updateLocalLineId(lines: string[], item: ObsidianLineItem, id: string) {
        const lastLineIdx = item.endLineIndex;
        if (lines[lastLineIdx] !== undefined) {
            lines[lastLineIdx] = `${lines[lastLineIdx]} ^${id}`;
        }
    }

    private cleanContent(str: string): string {
        return str.replace(/\s+/g, ' ').trim();
    }

    private escapeRegex(str: string) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private async getOrCreateDailyNote(momentDay: MomentInstance): Promise<TFile | null> {
        try {
            const existing = getDailyNote(momentDay, getAllDailyNotes());
            if (existing instanceof TFile) return existing;
            if (this.settings.createMissingDailyNotes) {
                const created = await createDailyNote(momentDay);
                if (created instanceof TFile) return created;
            }
            return null;
        } catch (error) {
            console.error('Failed to get/create daily note:', error);
            return null;
        }
    }
}

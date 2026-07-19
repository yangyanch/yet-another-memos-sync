// src/utils/syncStateManager.ts

import { App } from 'obsidian';
import { SyncStateStore, MemoSyncState } from '../types';

// 内部状态数据结构
interface SyncStateData {
    lastSyncByProfile: Record<string, string>;
    memoStatesByProfile: Record<string, Record<string, MemoSyncState>>;
    lastSyncDate: string;
}

export class SyncStateManager implements SyncStateStore {
    private app: App;
    private filePath: string = '_sync-state.json'; // 你指定的路径
    private data: SyncStateData;

    constructor(app: App) {
        this.app = app;
        // 初始化默认数据
        this.data = {
            lastSyncByProfile: {},
            memoStatesByProfile: {},
            lastSyncDate: ''
        };
    }

    // 插件启动时调用，从磁盘加载数据
    async load() {
        try {
            // 如果使用 Obsidian Sync，adapter.exists 可能会有延迟，但通常没问题
            if (await this.app.vault.adapter.exists(this.filePath)) {
                const content = await this.app.vault.adapter.read(this.filePath);
                this.data = Object.assign({}, this.data, JSON.parse(content));
                console.log("Memos Sync: Loaded state from file.", this.filePath);
            } else {
                console.log("Memos Sync: State file not found, using default.");
            }
        } catch (e) {
            console.error("Memos Sync: Failed to load state file, resetting.", e);
            // 如果读取失败，保持默认空数据，防止崩溃
        }
    }

    // 保存数据到磁盘
    private async save() {
        try {
            // 确保文件夹存在
            const folderPath = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
            if (!(await this.app.vault.adapter.exists(folderPath))) {
                await this.app.vault.adapter.mkdir(folderPath);
            }
            
            await this.app.vault.adapter.write(this.filePath, JSON.stringify(this.data, null, 2));
        } catch (e) {
            console.error("Memos Sync: Failed to save state file", e);
        }
    }

    // --- 实现接口方法 ---

    getLastSync(profileId: string): string {
        return this.data.lastSyncByProfile[profileId] || '0';
    }

    async setLastSync(profileId: string, value: string): Promise<void> {
        this.data.lastSyncByProfile[profileId] = value;
        await this.save();
    }

    async markSyncedToday(): Promise<void> {
        const today = new Date().toDateString();
        // 简单记录同步日期，用于 skipIfSyncedToday
        this.data.lastSyncDate = today;
        await this.save();
    }
    
    // 辅助方法：检查今天是否同步过（在 main.ts 中可能用到）
    hasSyncedToday(): boolean {
        return this.data.lastSyncDate === new Date().toDateString();
    }

    getMemoSyncState(profileId: string, memoId: string): MemoSyncState | undefined {
        if (!this.data.memoStatesByProfile[profileId]) return undefined;
        return this.data.memoStatesByProfile[profileId][memoId];
    }

    async setMemoSyncState(profileId: string, memoId: string, state: MemoSyncState): Promise<void> {
        if (!this.data.memoStatesByProfile[profileId]) {
            this.data.memoStatesByProfile[profileId] = {};
        }
        this.data.memoStatesByProfile[profileId][memoId] = state;
        await this.save();
    }

    async deleteMemoSyncState(profileId: string, memoId: string): Promise<void> {
        if (this.data.memoStatesByProfile[profileId]) {
            delete this.data.memoStatesByProfile[profileId][memoId];
            await this.save();
        }
    }
}

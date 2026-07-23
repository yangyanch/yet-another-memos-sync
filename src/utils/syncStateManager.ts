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
    private filePath: string; // 使用从外部传入的路径
    private data: SyncStateData;

    // --- [修改] 构造函数接收可选的 filePath 参数 ---
    constructor(app: App, filePath?: string) {
        this.app = app;
        // 如果提供了路径则使用，否则使用默认路径
        this.filePath = filePath || '.memos_sync/sync-state.json';
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
                console.log(`Memos Sync: Loaded state from file: ${this.filePath}`);
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
            const lastSlash = this.filePath.lastIndexOf('/');
            // 只有当路径包含文件夹时才处理
            if (lastSlash > 0) {
                const folderPath = this.filePath.substring(0, lastSlash);
                if (!(await this.app.vault.adapter.exists(folderPath))) {
                    await this.app.vault.adapter.mkdir(folderPath);
                }
            }
            
            await this.app.vault.adapter.write(this.filePath, JSON.stringify(this.data, null, 2));
        } catch (e) {
            console.error("Memos Sync: Failed to save state file", e);
        }
    }

    // --- [新增] 重置状态方法 ---
    public async reset(): Promise<void> {
        this.data = {
            lastSyncByProfile: {},
            memoStatesByProfile: {},
            lastSyncDate: ''
        };
        await this.save();
        console.log("Memos Sync: Sync state has been reset.");
    }

    // --- [修改] 获取最后同步时间戳（返回毫秒，用于 UI 显示） ---
    public getLastSyncTime(): number {
        let latestTime = 0;
        // 遍历所有 profile 找到最新的同步时间（存储单位为秒）
        for (const profileId in this.data.lastSyncByProfile) {
            const time = parseInt(this.data.lastSyncByProfile[profileId]) || 0;
            if (time > latestTime) {
                latestTime = time;
            }
        }
        
        // [关键修复] 
        // 1. 如果有时间戳，乘以 1000 转换为毫秒，以适配 new Date()
        // 2. 如果没有时间戳（为0），返回当前时间，避免显示 1970 年
        return latestTime > 0 ? latestTime * 1000 : Date.now();
    }

    // --- [新增] 获取已同步 Memo 总数，用于UI显示 ---
    public getSyncedMemoCount(): number {
        let count = 0;
        for (const profileId in this.data.memoStatesByProfile) {
            count += Object.keys(this.data.memoStatesByProfile[profileId]).length;
        }
        return count;
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
        const today = new Date().toDateString(); // 简单记录同步日期，用于 skipIfSyncedToday
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

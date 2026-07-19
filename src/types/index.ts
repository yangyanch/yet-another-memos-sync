// Core types for Memos API (v0.22+ uses /api/v1; older `createdTs` kept for compat)
export interface Memo {
    id?: number | string;
    name?: string;
    uid?: string;
    content: string;
    timestamp?: number;
    createdTs?: number;
    createdAt?: string;
    createTime?: string;
    attachments?: Resource[];
    resourceList?: Resource[];
    resources?: Resource[];
}

export interface Resource {
    id?: string;
    name?: string;
    filename?: string;
    type?: string;
    size?: number;
    externalLink: string;
    uid?: string;
}

export interface DailyMemo {
    date: string;
    timestamp: string;
    content: string;
}

export interface MemosProfile {
    id: string;
    name: string;
    apiUrl: string;
    apiToken: string;
    dailyMemoHeader: string;
    syncDaysLimit: number;
    enabled: boolean;
}

// --- 新增：同步状态结构 ---
export interface MemoSyncState {
    hash: string;  // 内容哈希值，用于比对变更
    time: number;  // 最后同步时间戳
}

export interface MemosSettings {
    // Profiles - one per memos account/instance
    profiles: MemosProfile[];

    // Shared formatting settings
    attachmentFolderPath: string;
    createMissingDailyNotes: boolean;
    useCalloutFormat: boolean;
    useListCalloutFormat: boolean;
    skipImages: boolean;

    // Auto sync
    enableAutoSyncOnStartup: boolean;
    startupSyncDelay: number;
    skipIfSyncedToday: boolean;
    periodicSyncInterval: number;

    // Persisted sync state (per profile id -> latest synced unix seconds)
    lastSyncByProfile: Record<string, string>;
    lastSyncDate: string;

    // 新增设置
    showEmoji: boolean;
    tagMode: 'none' | 'smart' | 'always';
    customTag: string;

    // --- 新增：智能同步状态存储 ---
    // 结构: { [profileId]: { [memoId]: { hash, time } } }
    memoStatesByProfile: Record<string, Record<string, MemoSyncState>>;
}

export interface ListMemosPage {
    memos: Memo[];
    nextPageToken: string;
}

export interface ListMemosOptions {
    pageSize?: number;
    pageToken?: string;
    filter?: string;
}

export interface APIClient {
    listMemos(opts?: ListMemosOptions): Promise<ListMemosPage>;
    // 新增方法声明
    createMemo(content: string, createdTs?: number): Promise<Memo>;
    updateMemo(id: number | string, content: string): Promise<Memo>;
    deleteMemo(id: number | string): Promise<void>;
}

export interface MemosPaginator {
    foreach(handler: (dayData: [string, Record<string, string>]) => Promise<void>): Promise<string>;
}

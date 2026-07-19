/**
 * 从 attachment.name（形如 "attachments/ZXxKUPiM3389Xd3kTkv4is"）
 * 提取 uid（最后一段）。
 */
export function extractAttachmentUid(name: string): string {
    if (!name) return '';
    const idx = name.lastIndexOf('/');
    return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * 统一的文件名生成逻辑。
 * 确保下载时保存的文件名和 Markdown 里引用的文件名完全一致。
 * 
 * 优先级：
 * 1. res.filename (原始文件名)
 * 2. externalLink 路径解析
 * 3. res.name (UID)
 * 4. res.id (兜底)
 */
export function getSafeFilename(res: any): string {
    // 1. 优先使用原始文件名
    let filename = res.filename;

    // 2. 尝试从 externalLink 解析
    if (!filename && res.externalLink) {
        try {
            const urlObj = new URL(res.externalLink);
            const lastPart = urlObj.pathname.split('/').pop();
            if (lastPart && lastPart.includes('.')) {
                filename = lastPart;
            }
        } catch (e) {
            // URL 解析失败忽略
        }
    }

    // 3. 使用 name（UID）作为文件名（不带后缀）
    if (!filename && res.name) {
        filename = res.name;
    }

    // 4. 兜底：数字 ID
    if (!filename && res.id) {
        filename = `image-${res.id}`;
    }

    // 5. 终极兜底
    if (!filename) {
        filename = `file-${Date.now()}`;
    }

    // 清理非法字符
    filename = filename.replace(/[/\\?%*:|"<>]/g, "-");

    // 确保有后缀
    if (!filename.includes('.')) {
        filename += '.jpg';
    }

    return filename;
}

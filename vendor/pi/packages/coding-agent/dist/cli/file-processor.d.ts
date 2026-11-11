/**
 * Process @file CLI arguments into text content and media attachments
 */
import type { ImageContent, VideoContent } from "@earendil-works/pi-ai";
export interface ProcessedFiles {
    text: string;
    images: ImageContent[];
    videos: VideoContent[];
}
export interface ProcessFileOptions {
    /** Whether to auto-resize images. Default: true */
    autoResizeImages?: boolean;
}
/** Process @file arguments into text content and media attachments */
export declare function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles>;
//# sourceMappingURL=file-processor.d.ts.map
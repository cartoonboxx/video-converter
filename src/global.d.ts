type ConversionStatus = 'waiting' | 'converting' | 'done' | 'error' | 'cancelled';

interface ConversionProgress {
  index: number;
  total: number;
  inputPath: string;
  outputPath?: string;
  fileName: string;
  percent: number;
  status: ConversionStatus;
  error?: string;
}

interface ConvertSummary {
  cancelled: boolean;
  completed: number;
  failed: number;
  results: Array<{
    inputPath: string;
    outputPath?: string;
    ok: boolean;
    error?: string;
  }>;
}

interface Window {
  videoAPI: {
    selectVideos(): Promise<string[]>;
    getPathForFile(file: File): string;
    selectOutputDir(): Promise<string | null>;
    convertVideos(files: string[], outputDir: string): Promise<ConvertSummary>;
    cancelConversion(): Promise<void>;
    openFolder(folderPath: string): Promise<void>;
    onProgress(callback: (payload: ConversionProgress) => void): () => void;
  };
}

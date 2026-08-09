import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('videoAPI', {
  selectVideos: (): Promise<string[]> => ipcRenderer.invoke('select-videos'),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  selectOutputDir: (): Promise<string | null> => ipcRenderer.invoke('select-output-dir'),
  convertVideos: (files: string[], outputDir: string) =>
    ipcRenderer.invoke('convert-videos', { files, outputDir }),
  cancelConversion: (): Promise<void> => ipcRenderer.invoke('cancel-conversion'),
  openFolder: (folderPath: string): Promise<void> => ipcRenderer.invoke('open-folder', folderPath),
  onProgress: (callback: (payload: ConversionProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ConversionProgress) => callback(payload);
    ipcRenderer.on('conversion-progress', handler);
    return () => ipcRenderer.removeListener('conversion-progress', handler);
  }
});

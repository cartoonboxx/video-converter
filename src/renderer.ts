interface QueueItem {
  path: string;
  name: string;
  status: ConversionStatus;
  percent: number;
  error?: string;
}

const queue = new Map<string, QueueItem>();
let outputDir = '';
let isConverting = false;
let activeConversionTotal = 0;
let lastCompletedCount = 0;
let lastFailedCount = 0;

const addButton = document.querySelector<HTMLButtonElement>('#addButton')!;
const clearButton = document.querySelector<HTMLButtonElement>('#clearButton')!;
const outputButton = document.querySelector<HTMLButtonElement>('#outputButton')!;
const convertButton = document.querySelector<HTMLButtonElement>('#convertButton')!;
const cancelButton = document.querySelector<HTMLButtonElement>('#cancelButton')!;
const openFolderButton = document.querySelector<HTMLButtonElement>('#openFolderButton')!;
const fileList = document.querySelector<HTMLDivElement>('#fileList')!;
const emptyState = document.querySelector<HTMLDivElement>('#emptyState')!;
const outputPath = document.querySelector<HTMLDivElement>('#outputPath')!;
const summaryText = document.querySelector<HTMLDivElement>('#summaryText')!;
const totalProgress = document.querySelector<HTMLDivElement>('#totalProgress')!;
const totalProgressBar = document.querySelector<HTMLDivElement>('#totalProgressBar')!;
const queuePanel = document.querySelector<HTMLElement>('.queue-panel')!;

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function addFiles(files: string[]): void {
  if (files.length > 0) {
    lastCompletedCount = 0;
    lastFailedCount = 0;
  }

  for (const filePath of files) {
    if (!/\.(mov|avi)$/i.test(filePath)) continue;
    if (!queue.has(filePath)) {
      queue.set(filePath, {
        path: filePath,
        name: fileName(filePath),
        status: 'waiting',
        percent: 0
      });
    }
  }
  render();
}

function statusLabel(item: QueueItem): string {
  switch (item.status) {
    case 'converting': return `${Math.round(item.percent)}%`;
    case 'done': return 'Готово';
    case 'error': return 'Ошибка';
    case 'cancelled': return 'Отменено';
    default: return 'В очереди';
  }
}

function render(): void {
  const items = [...queue.values()];
  emptyState.hidden = items.length > 0;
  fileList.innerHTML = '';

  for (const item of items) {
    const row = document.createElement('div');
    row.className = `file-row status-${item.status}`;

    const main = document.createElement('div');
    main.className = 'file-main';

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = item.name;
    name.title = item.path;

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.textContent = item.error ? item.error : statusLabel(item);

    const progress = document.createElement('div');
    progress.className = 'item-progress';
    const fill = document.createElement('div');
    fill.className = 'item-progress-fill';
    fill.style.width = `${Math.max(0, Math.min(100, item.percent))}%`;
    progress.appendChild(fill);

    main.append(name, meta, progress);

    const remove = document.createElement('button');
    remove.className = 'remove-button';
    remove.textContent = '×';
    remove.title = 'Удалить из очереди';
    remove.disabled = isConverting;
    remove.addEventListener('click', () => {
      queue.delete(item.path);
      render();
    });

    row.append(main, remove);
    fileList.appendChild(row);
  }

  const ready = items.length > 0 && Boolean(outputDir) && !isConverting;
  convertButton.disabled = !ready;
  addButton.disabled = isConverting;
  clearButton.disabled = isConverting || items.length === 0;
  outputButton.disabled = isConverting;
  cancelButton.hidden = !isConverting;
  convertButton.hidden = isConverting;
  openFolderButton.disabled = !outputDir;

  const completed = items.filter((item) => item.status === 'done').length;
  const failed = items.filter((item) => item.status === 'error').length;
  const progressTotal = isConverting && activeConversionTotal > 0 ? activeConversionTotal : items.length;
  const avgProgress = progressTotal
    ? ((lastCompletedCount * 100) + items.reduce((sum, item) => sum + item.percent, 0)) / progressTotal
    : 0;

  totalProgressBar.style.width = `${Math.max(0, Math.min(100, avgProgress))}%`;
  totalProgress.hidden = !isConverting && completed === 0 && failed === 0;

  if (isConverting) {
    const processed = lastCompletedCount + lastFailedCount;
    summaryText.textContent = `Параллельная конвертация: ${processed} из ${activeConversionTotal || items.length}`;
  } else if (completed || failed) {
    summaryText.textContent = `Готово: ${completed}${failed ? ` · Ошибок: ${failed}` : ''}`;
  } else if (lastCompletedCount || lastFailedCount) {
    summaryText.textContent = `Готово: ${lastCompletedCount}${lastFailedCount ? ` · Ошибок: ${lastFailedCount}` : ''}`;
  } else {
    summaryText.textContent = `${items.length} ${items.length === 1 ? 'файл' : 'файлов'} в очереди`;
  }
}

addButton.addEventListener('click', async () => {
  const files = await window.videoAPI.selectVideos();
  addFiles(files);
});

clearButton.addEventListener('click', () => {
  queue.clear();
  lastCompletedCount = 0;
  lastFailedCount = 0;
  render();
});

outputButton.addEventListener('click', async () => {
  const selected = await window.videoAPI.selectOutputDir();
  if (selected) {
    outputDir = selected;
    outputPath.textContent = selected;
    outputPath.title = selected;
    render();
  }
});

openFolderButton.addEventListener('click', async () => {
  if (outputDir) {
    await window.videoAPI.openFolder(outputDir);
  }
});

cancelButton.addEventListener('click', async () => {
  cancelButton.disabled = true;
  cancelButton.textContent = 'Отмена…';
  await window.videoAPI.cancelConversion();
});

convertButton.addEventListener('click', async () => {
  if (!outputDir || queue.size === 0 || isConverting) return;

  lastCompletedCount = 0;
  lastFailedCount = 0;
  activeConversionTotal = queue.size;

  for (const item of queue.values()) {
    item.status = 'waiting';
    item.percent = 0;
    item.error = undefined;
  }

  isConverting = true;
  render();

  try {
    const result = await window.videoAPI.convertVideos([...queue.keys()], outputDir);
    if (result.cancelled) {
      for (const item of queue.values()) {
        if (item.status === 'waiting' || item.status === 'converting') {
          item.status = 'cancelled';
          item.percent = 0;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summaryText.textContent = `Ошибка запуска: ${message}`;
  } finally {
    isConverting = false;
    activeConversionTotal = 0;
    cancelButton.disabled = false;
    cancelButton.textContent = 'Отменить';
    render();
  }
});



document.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (!isConverting) queuePanel.classList.add('dragging');
});

document.addEventListener('dragleave', (event) => {
  if (event.clientX === 0 && event.clientY === 0) {
    queuePanel.classList.remove('dragging');
  }
});

document.addEventListener('drop', (event) => {
  event.preventDefault();
  queuePanel.classList.remove('dragging');
  if (isConverting || !event.dataTransfer) return;

  const paths: string[] = [];
  for (const file of Array.from(event.dataTransfer.files)) {
    try {
      const filePath = window.videoAPI.getPathForFile(file);
      if (filePath) paths.push(filePath);
    } catch {
      // Ignore non-disk File objects.
    }
  }
  addFiles(paths);
});

window.videoAPI.onProgress((progress) => {
  const item = queue.get(progress.inputPath);
  if (!item) return;

  if (progress.status === 'done') {
    lastCompletedCount += 1;
    queue.delete(progress.inputPath);
    render();
    return;
  }

  if (progress.status === 'error') {
    lastFailedCount += 1;
  }

  item.status = progress.status;
  item.percent = progress.percent;
  item.error = progress.error;
  render();
});

render();

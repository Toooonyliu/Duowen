import { exportRecording } from './exporters.js';

self.addEventListener('message', async event => {
  try {
    const { recording, options } = event.data;
    const { blob, filename } = await exportRecording(recording, 'pdf', options);
    self.postMessage({ type: 'complete', blob, filename });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || 'The PDF could not be generated.' });
  }
}, { once: true });

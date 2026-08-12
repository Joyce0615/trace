const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trace", {
  chooseRepository: () => ipcRenderer.invoke("repository:choose"),
  openRepository: (source) => ipcRenderer.invoke("repository:open", source),
  readFile: (rootPath, filePath) => ipcRenderer.invoke("repository:read-file", { rootPath, filePath }),
  detectAgents: () => ipcRenderer.invoke("agents:detect"),
  askAgent: (request) => ipcRenderer.invoke("agents:ask", request),
  enhanceCourse: (request) => ipcRenderer.invoke("course:enhance", request),
  loadLearning: (request) => ipcRenderer.invoke("learning:load", request),
  saveLearning: (state) => ipcRenderer.invoke("learning:save", state),
  createPractice: (request) => ipcRenderer.invoke("practice:create", request),
  inspectPractice: (sessionId) => ipcRenderer.invoke("practice:inspect", sessionId),
  openPractice: (sessionId) => ipcRenderer.invoke("practice:open", sessionId),
  removePractice: (request) => ipcRenderer.invoke("practice:remove", request),
});

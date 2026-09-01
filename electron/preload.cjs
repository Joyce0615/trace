const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trace", {
  chooseRepository: () => ipcRenderer.invoke("repository:choose"),
  openRepository: (source) => ipcRenderer.invoke("repository:open", source),
  cancelRepositoryOpen: (requestId) => ipcRenderer.invoke("repository:cancel", requestId),
  indexLimits: () => ipcRenderer.invoke("repository:limits"),
  onIndexProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("repository:progress", listener);
    return () => ipcRenderer.removeListener("repository:progress", listener);
  },
  readFile: (rootPath, filePath) => ipcRenderer.invoke("repository:read-file", { rootPath, filePath }),
  detectAgents: () => ipcRenderer.invoke("agents:detect"),
  detectLanguageServers: () => ipcRenderer.invoke("index:language-servers"),
  resolveSymbol: (request) => ipcRenderer.invoke("index:resolve", request),
  graphSummary: (request) => ipcRenderer.invoke("graph:summary", request),
  graphNeighborhood: (request) => ipcRenderer.invoke("graph:neighborhood", request),
  classifyLink: (url) => ipcRenderer.invoke("links:classify", { url }),
  openLink: (url) => ipcRenderer.invoke("links:open", { url }),
  lastLinkDecision: () => ipcRenderer.invoke("links:last-decision"),
  callChains: (request) => ipcRenderer.invoke("lessons:call-chains", request),
  gradePrediction: (request) => ipcRenderer.invoke("lessons:grade-prediction", request),
  askAgent: (request) => ipcRenderer.invoke("agents:ask", request),
  enhanceCourse: (request) => ipcRenderer.invoke("course:enhance", request),
  loadLearning: (request) => ipcRenderer.invoke("learning:load", request),
  saveLearning: (state) => ipcRenderer.invoke("learning:save", state),
  createPractice: (request) => ipcRenderer.invoke("practice:create", request),
  inspectPractice: (sessionId) => ipcRenderer.invoke("practice:inspect", sessionId),
  openPractice: (sessionId) => ipcRenderer.invoke("practice:open", sessionId),
  removePractice: (request) => ipcRenderer.invoke("practice:remove", request),
});

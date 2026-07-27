const importer = require('../../services/docx-importer');
const localAI = require('../../services/local-ai-model');

const AI_EXTENSIONS = ['docx', 'docm', 'dotx', 'dotm', 'doc', 'rtf', 'odt', 'txt', 'md', 'markdown', 'html', 'htm'];
const WORD_EXTENSIONS = ['docx', 'docm', 'dotx', 'dotm', 'doc', 'rtf', 'odt'];
const TABLE_EXTENSIONS = ['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'ods', 'csv', 'tsv'];

function parseButtonText(extension = '') {
  const ext = String(extension || '').toLowerCase();
  if (WORD_EXTENSIONS.includes(ext)) return '开始解析 Word';
  if (TABLE_EXTENSIONS.includes(ext)) return '开始解析表格';
  if (['txt', 'md', 'markdown', 'html', 'htm'].includes(ext)) return '开始解析文本';
  if (ext === 'pdf') return '开始解析 PDF';
  return '读取题库包';
}

Page({
  data: {
    importing: false,
    progress: 0,
    stage: '',
    fileReady: false,
    selectedName: '',
    selectedSize: '',
    selectedExtension: '',
    aiSupported: false,
    parseButtonText: '开始解析',
    aiIndex: 0,
    useLocalAI: false,
    modelStatus: '选择 AI 模式后执行本地自检',
    modelReady: false,
    modelVersion: localAI.MODEL_VERSION,
    tips: [
      '文件选择器仅显示文档/文本类文件；真正可导入的扩展名由当前版本支持列表统一控制，后续新增格式时会同步更新。',
      'Word：支持 .doc、.docx、.docm、.dotx、.dotm、.rtf 和 .odt；会利用正文、表格、下划线/高亮/答案色等结构识别题干与答案。',
      '表格：支持 .xls、.xlsx、.xlsm、.xltx、.xltm、.ods、.csv 和 .tsv；会自动识别工作表、表头、题型、难度、答案、解析和图片。',
      '文本：支持 .txt、.md、.markdown、.html 和 .htm；兼容题后答案、题前答案、文末集中答案、多空填空、判断符号、材料题、匹配题、排序题等常见写法。',
      'PDF：支持有文字层的标准文件，并处理常见双栏阅读顺序、重复页眉页脚、跨页题目和字体映射；扫描版仍暂不启用 OCR。',
      '结构冲突或无法可靠判断的题目不会强猜，会进入异常检查，并按置信度从低到高优先展示。'
    ]
  },

  formatSize(size) {
    const value = Number(size) || 0;
    if (!value) return '';
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  },

  async chooseFile() {
    if (this.data.importing) return;
    try {
      const file = await importer.chooseFile();
      if (this.selectedFile && this.selectedFile !== file) importer.releasePickedFile(this.selectedFile);
      this.selectedFile = file;
      const name = file.name || '未命名文件';
      const extension = (name.split('.').pop() || '').toLowerCase();
      const aiSupported = AI_EXTENSIONS.includes(extension);
      this.setData({
        fileReady: true,
        selectedName: name,
        selectedSize: this.formatSize(file.size),
        selectedExtension: extension,
        aiSupported,
        parseButtonText: parseButtonText(extension),
        progress: 0,
        stage: '文件已选择，等待解析',
        aiIndex: 0,
        useLocalAI: false,
        modelReady: false,
        modelStatus: '选择 AI 模式后执行本地自检'
      });
    } catch (error) {
      const cancelled = /cancel/i.test(error.errMsg || error.message || '');
      if (!cancelled) wx.showModal({ title: '选择失败', content: error.message || error.errMsg || String(error), showCancel: false });
    }
  },

  async selectMode(event) {
    if (this.data.importing || !this.data.aiSupported) return;
    const index = Number(event.currentTarget.dataset.index) || 0;
    if (index === 0) {
      this.setData({ aiIndex: 0, useLocalAI: false, modelReady: false, modelStatus: '默认规则解析，不加载模型' });
      return;
    }
    this.setData({ aiIndex: 1, useLocalAI: false, modelReady: false, modelStatus: '正在按需加载本地模型…' });
    try {
      const check = await localAI.selfTestAsync();
      this.setData({
        aiIndex: 1,
        useLocalAI: check.ok,
        modelReady: check.ok,
        modelVersion: check.version,
        modelStatus: check.ok ? `已加载 ${check.version}，本地自检通过` : `模型自检失败：${check.message}`
      });
      if (!check.ok) wx.showModal({ title: '模型不可用', content: check.message, showCancel: false });
    } catch (error) {
      this.setData({ aiIndex: 1, useLocalAI: false, modelReady: false, modelStatus: `模型加载失败：${error.message || error}` });
      wx.showModal({ title: '模型不可用', content: error.message || String(error), showCancel: false });
    }
  },

  clearFile() {
    if (this.data.importing) return;
    importer.releasePickedFile(this.selectedFile);
    this.selectedFile = null;
    this.setData({
      fileReady: false,
      selectedName: '',
      selectedSize: '',
      selectedExtension: '',
      aiSupported: false,
      parseButtonText: '开始解析',
      progress: 0,
      stage: '',
      aiIndex: 0,
      useLocalAI: false,
      modelReady: false,
      modelStatus: '选择 AI 模式后执行本地自检'
    });
  },

  async startParse() {
    if (this.data.importing) return;
    if (!this.selectedFile) {
      wx.showToast({ title: '请先选择文件', icon: 'none' });
      return;
    }
    if (this.data.aiIndex === 1 && !this.data.modelReady) {
      wx.showModal({ title: '模型未就绪', content: '本地模型尚未通过自检，请重新选择 AI 模式。', showCancel: false });
      return;
    }
    const selectedFile = this.selectedFile;
    this.setData({ importing: true, progress: 1, stage: '准备解析' });
    try {
      const draft = await importer.importSelected(
        selectedFile,
        { useLocalAI: this.data.aiSupported && this.data.useLocalAI },
        (progress, stage) => this.setData({ progress, stage })
      );
      getApp().globalData.importDraft = draft;
      wx.redirectTo({ url: '/pages/import-result/import-result' });
    } catch (error) {
      console.error(error);
      this.setData({
        importing: false,
        fileReady: false,
        selectedName: '',
        selectedSize: '',
        selectedExtension: '',
        aiSupported: false,
        parseButtonText: '开始解析',
        stage: '解析失败，请重新选择文件'
      });
      wx.showModal({ title: '解析失败', content: error.message || error.errMsg || String(error), showCancel: false });
    } finally {
      importer.releasePickedFile(selectedFile);
      if (this.selectedFile === selectedFile) this.selectedFile = null;
    }
  },

  onUnload() {
    if (!this.data.importing) {
      importer.releasePickedFile(this.selectedFile);
      this.selectedFile = null;
    }
  }
});

/**
 * 模块职责: 汇总导出 harvest 域内所有服务模块与对外公共 API
 * 依赖: ./scaffolding.js, ./dialog-extract.js, ./project-resolve.js, ./extract.js, ./classify.js, ./harvest-pipeline.js, ./offline-scan.js, ./hook-request.js, ./hook-response.js
 * 被依赖: gateway_harvest.hooks.js, gateway_harvest.js, tests
 */

export {
  SCAFFOLDING_PATTERNS,
  stripScaffolding} from "./scaffolding.js";

export {
  isExplicitUserMemory,
  extractLastUserTurn,
  extractTextFromMessages,
  extractTextFromReply,
  buildDialogueText,
  countTurnsFromMessages,
  parseExtractionJson} from "./dialog-extract.js";

export {
  deriveProjectFromCwd,
  deriveProject} from "./project-resolve.js";

export {
  classifyEndpointCache,
  classifyDialogueWithOnlineModel,
  testClassificationModel} from "./classify.js";

export {
  HARVEST_SYSTEM_PROMPT,
  harvestWithOnlineModel,
  testExtractionModel,
  testModelConnectivity} from "./extract.js";

export {
  turnFingerprint,
  fingerprint,
  processDialogueAndHarvest,
  triggerBackgroundDrain} from "./harvest-pipeline.js";

export {
  GATEWAY_CONV_DIRNAME,
  NO_CONVERSATIONS_MSG,
  HARD_FORBIDDEN_PREFIXES,
  FORBIDDEN_PREFIXES,
  isVarSubdomainAllowed,
  isHomeOrRootAllowed,
  isWhitelistedGatewayDir,
  checkSensitiveSubpaths,
  validateGatewayDir,
  resolveGatewayDir,
  collectConversationFiles,
  isTestMode,
  harvestGateway} from "./offline-scan.js";

export {
  onRequest} from "./hook-request.js";

export {
  computeHookBudgetMs,
  onResponse} from "./hook-response.js";

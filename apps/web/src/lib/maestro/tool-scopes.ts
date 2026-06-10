/**
 * Map Maestro tool names to required PAT scopes.
 *
 * Keep this in `lib/` (not the actions file) so it can be imported by
 * the MCP route, the Maestro chat route, and the UI.
 */

import type { PatScope } from "@/lib/agent-pat-scopes";

export const MAESTRO_TOOL_SCOPES: Record<string, PatScope[]> = {
    listLibraryTracks: ["library:read"],
    getTrackDetails: ["library:read"],
    rateTrack: ["library:write"],
    listDawProjects: ["daw:read"],
    getDawProject: ["daw:read"],
    listDawTracks: ["daw:read"],
    listDawClips: ["daw:read"],
    createDawTrack: ["daw:write"],
    setDawProjectTempo: ["daw:write"],
    setDawProjectTimeSignature: ["daw:write"],
    createDawClip: ["daw:write"],
    moveDawClip: ["daw:write"],
    setDawTrackVolume: ["daw:write"],
    addMidiNotes: ["daw:write"],
    exportDawProject: ["daw:read"],
    // Advanced edit/FX/automation/samples
    setDawTrackPan: ["daw:write"],
    deleteDawClip: ["daw:write"],
    duplicateDawClip: ["daw:write"],
    deleteDawTrack: ["daw:write"],
    listFxTypes: ["daw:read"],
    addFxInsert: ["daw:write"],
    removeFxInsert: ["daw:write"],
    setFxParam: ["daw:write"],
    addAutomationPoint: ["daw:write"],
    addAutomationPoints: ["daw:write"],
    addRhythmicDuck: ["daw:write"],
    renameDawTrack: ["daw:write"],
    setDawTrackColor: ["daw:write"],
    getMasterTrack: ["daw:read"],
    setMasterVolume: ["daw:write"],
    addMasterFx: ["daw:write"],
    setMasterFxParam: ["daw:write"],
    removeMasterFx: ["daw:write"],
    awaitAssetReady: ["daw:read"],
    searchSamples: ["library:read"],
    listSampleCategories: ["library:read"],
    createSampleAudioClip: ["daw:write"],
    generateMusic: ["daw:write"],
    listAceStepLoras: ["daw:read"],
    separateAssetStems: ["daw:write"],
    prepareAceStepDataset: ["daw:write"],
    trainAceStepLora: ["daw:write"],
    listRvcVoiceModels: ["daw:read"],
    convertVocalWithRVC: ["daw:write"],
    getGenerationStatus: ["daw:read"],
    synthesizeVocal: ["daw:write"],
    synthesizeIntro: ["daw:write"],
    listClonedVoices: ["daw:read"],
    sendAssetToDaw: ["daw:write"],
    recommendSimilar: ["daw:read"],
    masterAsset: ["daw:write"],
    createReturnTrack: ["daw:write"],
    addSendRoute: ["daw:write"],
    // Project lifecycle, navigation, feedback
    createDawProject: ["daw:write"],
    renameDawProject: ["daw:write"],
    navigateApp: ["daw:read"],
    reportMaestroIssue: ["daw:read"],
    updateConversationMeta: ["daw:read"],
    // Training platform
    listTrainingJobs: ["training:read"],
    getTrainingJob: ["training:read"],
    getTrainingProgress: ["training:read"],
    proposeTrainingJob: ["training:read"],
    proposeGenreTrainingPlan: ["training:read"],
    submitTrainingJob: ["training:write"],
    patchTrainingControl: ["training:write"],
    cancelTrainingJob: ["training:write"],
    listTrainingDatasets: ["training:read"],
    buildDatasetFromThumbsUp: ["training:write"],
    buildDatasetFromLibrary: ["training:write"],
    buildDatasetFromAssets: ["training:write"],
    buildDatasetFromSamplePack: ["training:write"],
    materializeDataset: ["training:write"],
    setDatasetItemCaption: ["training:write"],
    listLoras: ["training:read"],
    updateLora: ["training:write"],
    recordGenerationFeedback: ["feedback:write"],
    summarizeFeedback: ["training:read"],
};

/** Returns true when every required scope for `toolName` is in `granted`. */
export function toolAllowedBy(toolName: string, granted: readonly PatScope[]): boolean {
    const required = MAESTRO_TOOL_SCOPES[toolName];
    if (!required || required.length === 0) return true;
    return required.every((s) => granted.includes(s));
}

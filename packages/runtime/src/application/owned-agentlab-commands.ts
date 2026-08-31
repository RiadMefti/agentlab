import type { AgentLabCommandPort } from "./agentlab-commands.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

/** Applies runtime ownership to every interactive command without widening the generic task owner. */
export function ownAgentLabCommands(
  commands: AgentLabCommandPort,
  tasks: RuntimeTaskOwner
): AgentLabCommandPort {
  return {
    listConversations: () => tasks.run(() => commands.listConversations()),
    inspectWorkspace: (workspacePath) => tasks.run(() => commands.inspectWorkspace(workspacePath)),
    prepareWorkspace: (workspacePath) => tasks.run(() => commands.prepareWorkspace(workspacePath)),
    discoverWorkspaceProviders: (workspacePath) =>
      tasks.run(() => commands.discoverWorkspaceProviders(workspacePath)),
    completeFolders: (input) => tasks.run(() => commands.completeFolders(input)),
    listProviders: (conversationId) => tasks.run(() => commands.listProviders(conversationId)),
    createConversation: (input) => tasks.run(() => commands.createConversation(input)),
    deleteConversation: (conversationId) =>
      tasks.run(() => commands.deleteConversation(conversationId)),
    listSessions: (conversationId) => tasks.run(() => commands.listSessions(conversationId)),
    createWorker: (conversationId, input) =>
      tasks.run(() => commands.createWorker(conversationId, input)),
    deleteWorker: (conversationId, sessionName) =>
      tasks.run(() => commands.deleteWorker(conversationId, sessionName)),
    requireAttachableSession: (conversationId, sessionName) =>
      tasks.run(() => commands.requireAttachableSession(conversationId, sessionName))
  };
}

// Codex CLI harness. Keybindings verified against the real CLI (codex-cli
// 0.144.4): slash commands read from the binary's command menu (`/new` =
// "start a new chat during a conversation", `/model` = "choose what model and
// reasoning effort to use") and the docs at https://learn.chatgpt.com/docs/codex/cli.
// Unsupported actions return null rather than sending guessed input.

import { installCodexHooks } from '../hooks-install.js'
import type { Action, AgentState, Harness } from './types.js'

export const codexHarness: Harness = {
  kind: 'codex',
  command: 'codex',

  buildArgs(userArgs: string[]): string[] {
    return userArgs
  },

  installHooks() {
    const result = installCodexHooks()
    // Codex trust is definition-hash based: a changed hooks.json must be re-trusted.
    return {
      changed: result === 'changed',
      trustNotice:
        result === 'changed'
          ? 'opencontrol: Codex hooks changed — open /hooks in Codex and trust the OpenControl hooks'
          : null,
    }
  },

  stateForHookEvent(event: string, _payload: unknown): AgentState | null {
    switch (event) {
      case 'UserPromptSubmit':
      case 'PostToolUse':
        return 'executing'
      case 'PermissionRequest':
        return 'waiting'
      case 'Stop':
        return 'complete'
      case 'ProcessFailure':
        return 'error'
      default:
        return null
    }
    // ponytail: no 'error' branch. Codex ships no error hook event, so there is
    // no signal to map. Upgrade path: sniff a future error event if one lands.
  },

  resolveAction(action: Action, _ctx: { thinkingLevel: number }) {
    switch (action.type) {
      case 'agent_command':
        switch (action.command) {
          case 'fast':
            return { bytes: '/fast\r' }
          case 'approve':
          case 'send':
            return { bytes: '\r' }
          case 'decline':
            return { bytes: '\x1b' }
          case 'fork':
            return { bytes: '/fork\r' }
          case 'plan':
            return { bytes: '/plan\r' }
          case 'skills':
            return { bytes: '/skills\r' }
          case 'model_picker':
            return { bytes: '/model\r' }
          case 'mic':
            return null
        }
      case 'accept':
        return { bytes: '\r' } // Enter submits
      case 'reject':
        return { bytes: '\x1b' } // Esc interrupts the running turn
      case 'new_chat':
        return { bytes: '/new\r' } // "start a new chat during a conversation"
      case 'prompt':
        return { bytes: action.text + '\r' }
      case 'keys':
        return { bytes: action.bytes }
      case 'push_to_talk':
        // Voice is intentionally deferred for the CLI-focused v1.
        return null
      case 'thinking_depth':
        // Documented gap: reasoning effort is only adjustable via the interactive
        // `/model` picker (left/right arrows). No deterministic per-step command
        // exists to map a ±1 dial delta onto, so we return null instead of
        // guessing arrow-key macros against a picker layout we can't verify.
        return null
      default:
        return null // workflow/focus_session/focus_relative/layer never reach a harness
    }
  },
}

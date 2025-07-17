import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js"
import type * as rpc from "vscode-jsonrpc"
import type {
	WorkDoneProgressBegin,
	WorkDoneProgressEnd,
	WorkDoneProgressReport,
} from "vscode-languageserver-protocol"

export function convertLspToMcp(
	message: WorkDoneProgressBegin | WorkDoneProgressReport | WorkDoneProgressEnd,
	token: rpc.ProgressToken,
): ProgressNotification {
	switch (message.kind) {
		case "begin":
			return {
				method: "notifications/progress",
				params: {
					progress: message.percentage ?? 0,
					progressToken: token,
					total: 100,
					message: message.message ?? message.title,
				},
			}
		case "report":
			return {
				method: "notifications/progress",
				params: {
					progress: message.percentage ?? 0,
					progressToken: token,
					total: 100,
					message: message.message ?? undefined,
				},
			}
		case "end":
			return {
				method: "notifications/progress",
				params: {
					progress: 100,
					progressToken: token,
					total: 100,
					message: message.message ?? undefined,
				},
			}
	}
}

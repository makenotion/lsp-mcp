import { describe, test, expect } from "vitest";
import { convertLspToMcp } from "./progress";
import {
	WorkDoneProgressBegin,
	WorkDoneProgressEnd,
	WorkDoneProgressReport,
} from "vscode-languageserver-protocol";

describe("Progress Reporting conversion", () => {
	const testToken = "test-token";

	test.each([
		// WorkDoneProgressBegin tests
		{
			name: "converts WorkDoneProgressBegin with all fields",
			input: {
				kind: "begin",
				title: "Test Title",
				message: "Test Message",
				percentage: 25,
			} as WorkDoneProgressBegin,
			expected: {
				method: "notifications/progress",
				params: {
					progress: 25,
					progressToken: testToken,
					total: 100,
					message: "Test Message",
				},
			},
		},
		{
			name: "converts WorkDoneProgressBegin with minimal fields",
			input: { kind: "begin", title: "Test Title" } as WorkDoneProgressBegin,
			expected: {
				method: "notifications/progress",
				params: {
					progress: 0,
					progressToken: testToken,
					total: 100,
					message: "Test Title",
				},
			},
		},
		{
			name: "converts WorkDoneProgressBegin with no message, falls back to title",
			input: {
				kind: "begin",
				title: "Fallback Title",
				percentage: 50,
			} as WorkDoneProgressBegin,
			expected: {
				method: "notifications/progress",
				params: {
					progress: 50,
					progressToken: testToken,
					total: 100,
					message: "Fallback Title",
				},
			},
		},
		// WorkDoneProgressReport tests
		{
			name: "converts WorkDoneProgressReport with all fields",
			input: {
				kind: "report",
				message: "Progress Update",
				percentage: 75,
			} as WorkDoneProgressReport,
			expected: {
				method: "notifications/progress",
				params: {
					progress: 75,
					progressToken: testToken,
					total: 100,
					message: "Progress Update",
				},
			},
		},
		{
			name: "converts WorkDoneProgressReport with minimal fields",
			input: { kind: "report" } as WorkDoneProgressReport,
			expected: {
				method: "notifications/progress",
				params: {
					progress: 0,
					progressToken: testToken,
					total: 100,
					message: undefined,
				},
			},
		},
		// WorkDoneProgressEnd tests
		{
			name: "converts WorkDoneProgressEnd with message",
			input: { kind: "end", message: "Task completed" } as WorkDoneProgressEnd,
			expected: {
				method: "notifications/progress",
				params: {
					progress: 100,
					progressToken: testToken,
					total: 100,
					message: "Task completed",
				},
			},
		},
		{
			name: "converts WorkDoneProgressEnd with no message",
			input: { kind: "end" } as WorkDoneProgressEnd,
			expected: {
				method: "notifications/progress",
				params: {
					progress: 100,
					progressToken: testToken,
					total: 100,
					message: undefined,
				},
			},
		},
	])("$name", ({ input, expected }) => {
		const result = convertLspToMcp(input, testToken);
		expect(result).toEqual(expected);
	});

	test("handles different token types", () => {
		const beginMessage: WorkDoneProgressBegin = {
			kind: "begin",
			title: "Test",
		};

		const numericToken = 12345;
		const result = convertLspToMcp(beginMessage, numericToken);

		expect(result.params.progressToken).toBe(numericToken);
	});
});

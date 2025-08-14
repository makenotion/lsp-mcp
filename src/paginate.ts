import type { JSONValue } from "./utils"

const RESULTS_PER_PAGE = 10
export function paginateResponse(
	response: string | JSONValue[],
	page: number,
	resultsPerPage: number = RESULTS_PER_PAGE,
): string {
	let pages = 1
	if (Array.isArray(response)) {
		pages = Math.ceil(response.length / resultsPerPage)
		response = response.slice(
			page * resultsPerPage,
			(page + 1) * resultsPerPage,
		)
	}
	return JSON.stringify({
		result: response,
		num_pages: pages,
	})
}

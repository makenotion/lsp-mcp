const RESULTS_PER_PAGE = 10;
export function paginateResponse(response: string, page: number): string {
  let pages: number = 1;
  if (Array.isArray(response)) {
    pages = Math.ceil(response.length / RESULTS_PER_PAGE);
    response = response.slice(
      page * RESULTS_PER_PAGE,
      (page + 1) * RESULTS_PER_PAGE,
    );
  }
  return JSON.stringify({
    result: response,
    num_pages: pages,
  });
}

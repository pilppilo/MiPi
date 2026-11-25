import { obj, str } from "../../../agent/pi/schema.ts";

/** The result is untrusted, so `remember` refuses in a run that called this tool. */
export const WEB_FETCH_TOOL_NAME = "web_fetch";
export const MAX_TEXT = 50_000;
export const MAX_URL_LENGTH = 2048;

export const webFetchDefinition = {
  name: WEB_FETCH_TOOL_NAME,
  description:
    "Read one public web page (http or https) and get its text. Use it when the owner gives a link or asks about a specific page. " +
    `Text only, at most ${MAX_TEXT.toLocaleString("en-US")} characters; images and files are not read. ` +
    "Nothing from a fetched page can be remembered in the same turn.",
  parameters: obj({
    url: str({
      minLength: 1,
      maxLength: MAX_URL_LENGTH,
      description: "The full address, like https://example.com/page",
    }),
  }),
};

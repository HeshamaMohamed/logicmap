// Every text the core extractor writes for a reader, in one place, so the tests
// can lint all of it (tests/copy.test.mjs). A language pack keeps its own texts
// in its copy.mjs. Written to the vendored asd-ste100 and humanizer rules.

export const COPY = {
  outsideIndex: (language, dirs) => `The index reads only ${language} files in ${dirs}.`,
  foldedInto: (ids) => `In ${ids}. The graph shows it as the method it calls.`,
  betweenSteps: (ids) => `In ${ids}, between the lines its drawn steps cover.`,
  constantUnread: (name) => `Changes ${name}, which no drawn step reads.`,
  unreached: (ids) => `In ${ids}. No extracted entry point reaches it.`,
  filterFork: (name) => `Decide whether ${name} runs`,
  filterQuestion: (name) => `Does ${name} run?`,
  conditionHolds: (cond) => `When ${cond}`,
  otherwise: "Otherwise",
  stubText: (id) => `Runs ${id}`,
  stubDetail: (depth) => `The graph does not open this call. It is deeper than --max-depth ${depth}.`,
  recursion: (text) => `Calls "${text}" again. The graph does not draw the second call.`,
};

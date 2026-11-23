// Synthetic reconstructions of task patterns reviewed in user-authorized
// ChatGPT/Claude history. No original identifiers, quotations or account data.
export const memoryFixtures = [
  {
    id: "application-channel",
    split: "development",
    subject: "graduate applications",
    initial:
      "I am applying for the research MSc at Alder University and the AI MSc at Birch University. Draft an email to my adviser.",
    correction:
      "Correction: this will be a chat message, not an email. Give only the university and course names. Keep this format for application lists.",
    query:
      "For my graduate application list, which two universities and programs did I choose and what message format do I want?",
    expected: ["Alder", "Birch", "MSc", "chat"],
    forbidden: [],
    noiseTurns: 8,
  },
  {
    id: "research-evidence",
    split: "development",
    subject: "company technical article",
    initial:
      "For the company technical article on coding-agent memory, use primary engineering sources and original measurements. Do not treat vendor rankings as benchmark evidence.",
    correction: "",
    query:
      "What evidence standard did I set for the company article about coding-agent memory?",
    expected: ["primary", "measure"],
    forbidden: [],
    noiseTurns: 24,
  },
  {
    id: "changed-workshop",
    split: "held-out",
    subject: "Cobalt workshop",
    initial:
      "Remember that the Cobalt workshop is on March 12, and I prefer morning workshops.",
    correction:
      "The Cobalt workshop moved to March 19. The March 12 date is obsolete. Remember the correction; I still prefer mornings.",
    query:
      "What is the current Cobalt workshop date and my preferred time of day?",
    expected: ["19", "morning"],
    forbidden: ["current date is March 12"],
    noiseTurns: 24,
  },
  ...[16, 128, 512].map((noiseTurns) => ({
    id: "distant-detail-" + noiseTurns,
    split: "held-out",
    subject: "Lighthouse research plan",
    initial:
      "Remember: the Lighthouse research plan uses a six-week pilot, the acceptance threshold is 93 percent recall, and the review code is ORBIT-731. The sponsor is the Cedar group.",
    correction: "",
    query:
      "For the Lighthouse research plan, what are the pilot duration, recall acceptance threshold, review code and sponsor?",
    expected: ["six-week", "93", "ORBIT-731", "Cedar"],
    forbidden: [],
    noiseTurns,
  })),
];
export function transcriptFor(f: (typeof memoryFixtures)[number]) {
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: f.initial },
    {
      role: "assistant",
      content: "Understood. I will use the supplied details.",
    },
  ];
  for (let i = 0; i < f.noiseTurns; i++)
    messages.push(
      {
        role: "user",
        content: `Temporary exercise ${i}: discuss a hypothetical river crossing with ${3 + (i % 7)} boats. This is a disposable reasoning exercise with no personal preference or lasting project decision. Explain assumptions and one example; do not remember the exercise as a fact about me.`,
      },
      {
        role: "assistant",
        content: `For temporary exercise ${i}, the number of boats constrains simultaneous crossings. A hypothetical solution uses a sequence of trips with an empty return when needed. The example is illustrative and supplies no durable fact about the user's life, work, relationships, deadlines or preferences.`,
      },
    );
  if (f.correction) messages.push({ role: "user", content: f.correction });
  return messages;
}

export function expectedDurableFacts(
  f: (typeof memoryFixtures)[number],
): string[] {
  if (f.id === "application-channel")
    return [
      "Applying to Alder University research MSc",
      "Applying to Birch University AI MSc",
      "Application lists should be chat messages with university and course names only",
    ];
  if (f.id === "research-evidence")
    return [
      "Writing a company technical article on coding-agent memory",
      "Use primary engineering sources",
      "Use original measurements",
      "Vendor rankings are not independent benchmark evidence",
    ];
  if (f.id === "changed-workshop")
    return [
      "Cobalt workshop current date is March 19; March 12 is obsolete",
      "Prefers morning workshops",
    ];
  return [
    "Lighthouse research pilot lasts six weeks",
    "Lighthouse acceptance threshold is 93 percent recall",
    "Lighthouse review code is ORBIT-731",
    "Lighthouse sponsor is the Cedar group",
  ];
}

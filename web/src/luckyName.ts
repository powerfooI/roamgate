export const luckyWorktreeBranchName = luckyName;
export const luckyWorkspaceName = luckyName;

async function luckyName() {
  const { adjectives, animals, uniqueNamesGenerator } = await import(
    "unique-names-generator"
  );
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: "-",
  });
}

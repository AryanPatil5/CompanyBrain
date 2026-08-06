// TODO: Implement a real pseudo-vector fallback for tests only
const generatePseudoVector = (text: string): number[] => {
  const hash = text.split('').reduce((acc, char) => {
    acc = ((acc << 5) - acc) + char.charCodeAt(0);
    return acc & acc;
  }, 0);
  return Array(1536).fill(0).map((_, i) => {
    const a = Math.sin(hash + i) * 2;
    return a - Math.floor(a);
  });
};

export { generatePseudoVector };
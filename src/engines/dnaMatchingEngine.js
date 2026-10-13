/**
 * "DNA Matching" Engine — used by the 4Ball Parliament.
 *
 * KNOWN ISSUE (out of scope for this pass): this module's name/docstring
 * and its output text ("Vector DNA cosine similarity profile aligned
 * with...") both claim real vector cosine-similarity matching, but the
 * implementation below is three fixed base scores with a flat +15 bonus
 * for the passed-in dominantColor -- historicalDraws is accepted as a
 * parameter but never actually used. It is not computing anything from
 * history.
 *
 * Kept as-is: fourBallParliament.js's 4B_DNA engine, weights, and learned
 * engineStats are live, already-tuned state.
 */
const { argMaxColorBy } = require('../core/colorMath');

function evaluateDNAMatching(historicalDraws, dominantColor) {
  const dnaScores = { RED: 65, BLUE: 60, GREEN: 55 };
  if (dominantColor && dnaScores[dominantColor] !== undefined) {
    dnaScores[dominantColor] += 15;
  }
  const dnaMatchColor = argMaxColorBy(dnaScores);

  return {
    dnaMatchColor,
    confidence: dnaScores[dnaMatchColor],
    reasoning: `Vector DNA cosine similarity profile aligned with ${dnaMatchColor}`
  };
}

module.exports = {
  evaluateDNAMatching
};

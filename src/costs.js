// Expressions SQL pures du calcul de couts. Sans effet de bord : testable tel quel.
// Codex : le raisonnement est inclus dans la sortie (total = input + output).
// OpenCode : compteurs disjoints, tarif raisonnement distinct.
export const estPart = {
  // Codex : input inclut le cache => input net = input - cached.
  // OpenCode : champs disjoints, comptage direct.
  input: "(CASE WHEN s.platform='codex' THEN MAX(s.input_tokens - s.cached_input_tokens, 0) ELSE s.input_tokens END * COALESCE(p.input_usd_per_million,0)) / 1000000.0",
  cached: "(s.cached_input_tokens * COALESCE(p.cached_input_usd_per_million,0)) / 1000000.0",
  output: "(s.output_tokens * COALESCE(p.output_usd_per_million,0)) / 1000000.0",
  reasoning: "(CASE WHEN s.platform='codex' THEN 0 ELSE s.reasoning_tokens END * COALESCE(p.reasoning_usd_per_million,0)) / 1000000.0",
};
export const estimatedCost = `(${estPart.input} + ${estPart.cached} + ${estPart.output} + ${estPart.reasoning})`;
// reported_cost_usd prioritaire quand renseigne ; 0 et NULL = pas d'info.
export const cost = `COALESCE(NULLIF(s.reported_cost_usd,0), ${estimatedCost})`;
// Total net : raisonnement Codex inclus dans la sortie, jamais ajoute.
export const tokenTotal = `(CASE WHEN s.platform='codex' THEN s.input_tokens + s.output_tokens ELSE s.input_tokens + s.cached_input_tokens + s.output_tokens + s.reasoning_tokens END)`;
// Ligne a zero = prix non saisi, jamais gratuite volontaire.
// Ligne vide = aucun token et aucun cout : exclue des compteurs, cout eventuel conserve.
export const nonemptyRow = `(NOT (COALESCE(s.input_tokens,0)=0 AND COALESCE(s.cached_input_tokens,0)=0 AND COALESCE(s.output_tokens,0)=0 AND COALESCE(s.reasoning_tokens,0)=0 AND COALESCE(s.total_tokens,0)=0 AND COALESCE(s.reported_cost_usd,0)=0))`;
// Prix manquant : ecritures cache et minute ignorees (hors calcul), tarif raisonnement exige seulement hors codex.
export const missingPriceCond = `(COALESCE(s.reported_cost_usd,0)=0 AND (p.model IS NULL OR (COALESCE(p.input_usd_per_million,0)=0 AND COALESCE(p.cached_input_usd_per_million,0)=0 AND COALESCE(p.output_usd_per_million,0)=0 AND (s.platform='codex' OR COALESCE(p.reasoning_usd_per_million,0)=0))))`;
export function buildCosts(subscriptionOn) {
  const api = cost;
  const openAiModel = `(LOWER(COALESCE(s.provider,''))='openai' OR LOWER(COALESCE(s.model,'')) GLOB 'gpt-*' OR LOWER(COALESCE(s.model,'')) LIKE '%/gpt-%' OR LOWER(COALESCE(s.model,'')) GLOB 'o[134]-*' OR LOWER(COALESCE(s.model,'')) LIKE 'chatgpt-%' OR LOWER(COALESCE(s.model,'')) LIKE 'codex-%')`;
  const openAiProvider = `(LOWER(COALESCE(s.provider,'')) IN ('openai',''))`;
  const covered = `((s.platform='codex' AND (${openAiProvider} OR ${openAiModel})) OR (s.platform='opencode' AND ${openAiModel} AND ${openAiProvider}))`;
  const paid = subscriptionOn ? `CASE WHEN ${covered} THEN 0 ELSE ${api} END` : api;
  // ventilation au prorata de l'estimation : suit le total reporte quand il existe, = estimation sinon.
  // Codex : la part raisonnement vaut 0, la sortie totale porte le tarif sortie.
  const share = `COALESCE((${api}) / NULLIF(${estimatedCost},0), 0)`;
  const part = {
    input: `COALESCE((${estPart.input}) * ${share}, 0)`,
    cached: `COALESCE((${estPart.cached}) * ${share}, 0)`,
    output: `COALESCE((${estPart.output}) * ${share}, 0)`,
    reasoning: `CASE WHEN s.platform='codex' THEN 0 ELSE COALESCE((${estPart.reasoning}) * ${share}, 0) END`,
  };
  const paidPart = (expr) => subscriptionOn ? `CASE WHEN ${covered} THEN 0 ELSE ${expr} END` : expr;
  return { api, paid, part, paidPart };
}

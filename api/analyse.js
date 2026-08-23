// =====================================================================
//  Fonction serveur — s'execute chez Vercel, jamais dans le navigateur.
//  C'est ce qui permet a la cle API de rester secrete.
//  Les consignes d'extraction sont en bas du fichier : c'est la partie
//  que vous ferez evoluer le plus souvent.
// =====================================================================

const MAX_CARACTERES = 60000;

module.exports = async function (req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ erreur: "Methode non autorisee" });
  }

  const corps = typeof req.body === "string" ? safeParse(req.body) : req.body;
  if (!corps) return res.status(400).json({ erreur: "Requete illisible" });

  const { pieces, tache, enveloppe } = corps;
  let consigne = PROMPTS[tache];

  // Une enveloppe a la fois : requetes plus courtes, donc plus rapides.
  if (tache === "exigences" && enveloppe) {
    consigne = consigne +
      "\n\nNe traite QUE l'enveloppe " + enveloppe + ". Ignore toutes les autres. " +
      "Maximum 15 entrees. Si aucune piece ne releve de cette enveloppe, renvoie {\"e\":[]}.";
  }

  if (!consigne) return res.status(400).json({ erreur: "Tache inconnue : " + tache });
  if (!Array.isArray(pieces) || pieces.length === 0) {
    return res.status(400).json({ erreur: "Aucune piece transmise" });
  }

  const cle = process.env.ANTHROPIC_API_KEY;
  if (!cle) {
    return res.status(500).json({
      erreur: "Cle API absente. Ajoutez ANTHROPIC_API_KEY dans Vercel > Settings > Environment Variables, puis redeployez.",
    });
  }

  const contenu = [];
  for (const p of pieces) {
    if (p.mode === "pdf" && p.b64) {
      contenu.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: p.b64 },
      });
      contenu.push({ type: "text", text: "Le document ci-dessus est la piece : " + p.nature + "." });
    } else if (p.texte && p.texte.trim()) {
      contenu.push({
        type: "text",
        text:
          "=== PIECE : " + p.nature + " ===\n" +
          p.texte.slice(0, MAX_CARACTERES) +
          "\n=== FIN DE LA PIECE " + p.nature + " ===",
      });
    }
  }

  if (contenu.length === 0) {
    return res.status(400).json({ erreur: "Les pieces transmises sont vides" });
  }

  contenu.push({ type: "text", text: consigne });

  try {
    const reponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cle,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.MODELE_CLAUDE || "claude-sonnet-5",
        max_tokens: 4000,
        messages: [{ role: "user", content: contenu }],
      }),
    });

    if (!reponse.ok) {
      const detail = await reponse.text();
      return res.status(502).json({
        erreur: "Service d'analyse indisponible (" + reponse.status + ")",
        detail: detail.slice(0, 400),
      });
    }

    const data = await reponse.json();
    const texte = (data.content || [])
      .map((i) => (i.type === "text" ? i.text : ""))
      .join("\n");
    const json = extraireJSON(texte);

    if (!json) return res.status(502).json({ erreur: "Reponse illisible du service d'analyse" });
    return res.status(200).json({ resultat: json });
  } catch (e) {
    return res.status(500).json({ erreur: "Echec de l'appel : " + e.message });
  }
};

function safeParse(t) {
  try { return JSON.parse(t); } catch { return null; }
}

// Le modele peut renvoyer du texte autour du JSON malgre la consigne :
// on isole le premier objet complet.
function extraireJSON(texte) {
  if (!texte) return null;
  const t = texte.replace(/```json/gi, "").replace(/```/g, "").trim();
  const d = t.indexOf("{");
  if (d === -1) return null;

  const f = t.lastIndexOf("}");
  if (f > d) {
    try { return JSON.parse(t.slice(d, f + 1)); } catch (e) { /* on tente la reparation */ }
  }

  // Reponse coupee en cours de route : on tronque au dernier objet complet
  // du tableau, puis on referme les crochets et accolades manquants.
  return reparerJSON(t.slice(d));
}

function reparerJSON(t) {
  const dernier = t.lastIndexOf("}");
  if (dernier === -1) return null;
  let base = t.slice(0, dernier + 1);
  for (let i = 0; i < 4; i++) {
    let ouverts = 0, crochets = 0, chaine = false, echap = false;
    for (const c of base) {
      if (echap) { echap = false; continue; }
      if (c === "\\") { echap = true; continue; }
      if (c === '"') { chaine = !chaine; continue; }
      if (chaine) continue;
      if (c === "{") ouverts++;
      if (c === "}") ouverts--;
      if (c === "[") crochets++;
      if (c === "]") crochets--;
    }
    const essai = base + "]".repeat(Math.max(0, crochets)) + "}".repeat(Math.max(0, ouverts));
    try { return JSON.parse(essai); } catch (e) {
      const precedent = base.lastIndexOf("},");
      if (precedent === -1) return null;
      base = base.slice(0, precedent + 1);
    }
  }
  return null;
}

// =====================================================================
//  CONSIGNES D'EXTRACTION
// =====================================================================

const SOCLE =
  "Tu analyses un dossier de consultation d'un marche public marocain regi par le decret 2-22-431. " +
  "Regles imperatives : n'invente rien ; ne complete jamais avec tes connaissances generales sur les " +
  "marches publics ; si une information ne figure pas dans les pieces fournies, laisse null ou une " +
  "liste vide. Reponds uniquement par un objet JSON valide, sans texte avant ni apres, sans balises de code.";

const PROMPTS = {
  coherence: SOCLE + `

Verifie que toutes les pieces fournies concernent bien LE MEME marche.
Compare pour chaque piece son objet, son maitre d'ouvrage et sa reference d'appel d'offres.

"compatible" vaut 0 uniquement si deux pieces designent manifestement des marches differents :
objets sans rapport, maitres d'ouvrage differents, references d'appel d'offres differentes.
Une simple difference de formulation ou un objet abrege ne suffisent pas : dans le doute, mets 1.

"motif" decrit en une phrase ce qui oppose les pieces, en les nommant. Laisse null si compatible.

Schema exact :
{"compatible":0|1,"motif":str|null,
"pieces":[{"nature":str,"objet":str|null,"maitre_ouvrage":str|null,"reference":str|null}]}`,

  parametres: SOCLE + `

Extrais les parametres de la consultation. Schema exact :
{"objet":str|null,"maitre_ouvrage":str|null,"reference":str|null,
"type_marche":"TRAVAUX"|"FOURNITURES"|"SERVICES"|"ETUDES"|null,
"estimation_mo":nombre|null,"delai_execution":nombre|null,"unite_delai":"MOIS"|"JOUR"|null,
"delais_partiels":str|null,
"date_limite":"AAAA-MM-JJ"|null,"heure_limite":str|null,"delai_validite_offres":nombre|null,
"cautionnement_provisoire":nombre|null,"penalite_retard":str|null,"revision_prix":str|null,
"qualification_exigee":str|null,"classe_exigee":str|null,
"mode_evaluation":str|null,"note_technique_min":nombre|null,
"sources":[{"champ":str,"ref":str,"extrait":str}]}

Le champ "ref" indique la piece et l'article, par exemple "RC art. 3".
Limite "sources" a 8 entrees, extraits de 10 a 25 mots recopies litteralement.`,

  exigences: SOCLE + `

Liste toutes les pieces, justificatifs et documents que le soumissionnaire doit produire.
Maximum 15 entrees. Une piece par entree : si une phrase en enumere cinq, produis cinq entrees.

"env" classe la piece dans l'enveloppe correspondante.
"x" doit etre un fragment recopie LITTERALEMENT des pieces fournies (8 a 25 mots).
"el" vaut 1 uniquement si le texte mentionne explicitement le rejet, l'irrecevabilite ou l'elimination.
"n" vaut 1 si la piece est notee, "pt" porte alors les points.
"c" est ta confiance de lecture, de 0 a 100.

Schema exact :
{"e":[{"env":"ADMINISTRATIF"|"TECHNIQUE"|"ADDITIF"|"OFFRE_TECHNIQUE"|"OFFRE_FINANCIERE",
"t":str,"ref":str,"x":str,"el":0|1,"n":0|1,"pt":nombre|null,"c":nombre}]}`,

  anomalies: SOCLE + `

Compare les pieces fournies et releve les problemes du dossier : contradictions entre pieces,
incoherences de quantites, silences (absence de clause de revision des prix, piece citee mais
absente du dossier), risques contractuels, risques de forme. Maximum 6 entrees, les plus lourdes de consequences.

Schema exact :
{"a":[{"s":"BLOQUANTE"|"MAJEURE"|"MINEURE"|"INFO",
"cat":"CONTRADICTION"|"INCOHERENCE"|"LACUNE"|"RISQUE_CONTRACTUEL"|"RISQUE_FORME",
"t":str,"d":str,"sa":str,"sb":str,"ac":str}]}

"sa" et "sb" citent deux emplacements precis, par exemple "RC art. 4" et "CPS art. 4".
"d" explique le probleme et sa consequence pratique en UNE phrase de 30 mots maximum.
"ac" indique l'action recommandee en trois a six mots.`,

  bordereau: SOCLE + `

Extrais les articles du bordereau des prix ou du detail estimatif. Maximum 30 articles ; au-dela,
retiens ceux dont les quantites ou les montants sont les plus eleves.

Schema exact :
{"b":[{"n":str,"d":str,"u":str,"q":nombre|null,"pu":nombre|null}],
"nb_articles_total":nombre|null,"total_annonce":nombre|null}

Si aucun bordereau n'est identifiable, renvoie
{"b":[],"nb_articles_total":null,"total_annonce":null}.`,
};

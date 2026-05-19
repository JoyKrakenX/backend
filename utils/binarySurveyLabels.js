/** @format */

const DEFAULT_BINARY_LABELS = Object.freeze({
	yes: 'Oui',
	no: 'Non',
	preset: 'yes_no',
});

const BINARY_LABEL_PRESETS = Object.freeze([
	{ preset: 'yes_no', yes: 'Oui', no: 'Non' },
	{ preset: 'true_false', yes: 'Vrai', no: 'Faux' },
	{ preset: 'for_against', yes: 'Pour', no: 'Contre' },
	{ preset: 'agree_disagree', yes: "D’accord", no: "Pas d’accord" },
	{ preset: 'satisfied_unsatisfied', yes: 'Satisfait', no: 'Insatisfait' },
	{ preset: 'accept_refuse', yes: 'Accepter', no: 'Refuser' },
]);

const PRESETS_BY_ID = new Map(
	BINARY_LABEL_PRESETS.map((entry) => [entry.preset, entry]),
);

const cleanLabel = (value, fallback) => {
	const label = String(value || '').trim();
	return label.length > 0 && label.length <= 60 ? label : fallback;
};

function normalizeBinaryLabels(input = {}) {
	const rawPreset = String(input?.preset || '').trim();
	const preset = PRESETS_BY_ID.get(rawPreset) || DEFAULT_BINARY_LABELS;

	const yes = cleanLabel(input?.yes, preset.yes);
	const no = cleanLabel(input?.no, preset.no);
	const normalizedPreset =
		[...PRESETS_BY_ID.values()].find(
			(entry) => entry.yes === yes && entry.no === no,
		)?.preset || preset.preset || DEFAULT_BINARY_LABELS.preset;

	return {
		yes,
		no,
		preset: normalizedPreset,
	};
}

module.exports = {
	DEFAULT_BINARY_LABELS,
	BINARY_LABEL_PRESETS,
	normalizeBinaryLabels,
};

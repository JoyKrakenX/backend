/** @format */

const fs = require('fs');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..');

const resolveRuntimeDir = (input, fallbackDir) => {
	const raw = String(input || '').trim();
	if (!raw) return fallbackDir;
	return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(backendRoot, raw);
};

const uploadsRoot = resolveRuntimeDir(
	process.env.UPLOADS_DIR,
	path.join(backendRoot, 'uploads'),
);

const ensureDir = (dirPath) => {
	fs.mkdirSync(dirPath, { recursive: true });
	return dirPath;
};

const getUploadsRoot = () => uploadsRoot;

const ensureUploadsRoot = () => ensureDir(uploadsRoot);

const getUploadsSubdir = (...segments) => path.join(uploadsRoot, ...segments);

const ensureUploadsSubdir = (...segments) =>
	ensureDir(getUploadsSubdir(...segments));

module.exports = {
	getUploadsRoot,
	ensureUploadsRoot,
	getUploadsSubdir,
	ensureUploadsSubdir,
};

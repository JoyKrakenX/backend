/** @format */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { EJSON } = require('bson');

require('dotenv').config({
	path: path.join(__dirname, '..', '.env'),
	quiet: true,
});

const User = require('../models/User');
const {
	DATA_COLLECTIONS,
	PURGE_ORDER,
} = require('./environment-data-collections');
const {
	getSupportAdminEmails,
	normalizeEmail,
} = require('../utils/supportAdminAllowlist');
const { getUploadsSubdir } = require('../utils/runtimePaths');

const DEFAULT_SCOPE = 'full';
const EXECUTE_CONFIRMATION_TOKEN = 'CLEAN_TEST_DATA';
const USERS_COLLECTION = User.collection.collectionName;

function timestampForFile() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
	const options = {
		mode: 'dry-run',
		scope: DEFAULT_SCOPE,
		keepAllowlistedAdmins: true,
		targetDb: '',
		confirm: '',
		backupDir: '',
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];

		if (arg === '--dry-run') {
			options.mode = 'dry-run';
			continue;
		}
		if (arg === '--execute') {
			options.mode = 'execute';
			continue;
		}
		if (arg === '--keep-allowlisted-admins') {
			options.keepAllowlistedAdmins = true;
			continue;
		}
		if (arg === '--no-keep-allowlisted-admins') {
			options.keepAllowlistedAdmins = false;
			continue;
		}
		if (arg === '--scope') {
			i += 1;
			if (!argv[i]) throw new Error('Missing value for --scope');
			options.scope = String(argv[i]).trim();
			continue;
		}
		if (arg === '--target-db') {
			i += 1;
			if (!argv[i]) throw new Error('Missing value for --target-db');
			options.targetDb = String(argv[i]).trim();
			continue;
		}
		if (arg === '--confirm') {
			i += 1;
			if (!argv[i]) throw new Error('Missing value for --confirm');
			options.confirm = String(argv[i]).trim();
			continue;
		}
		if (arg === '--backup-dir') {
			i += 1;
			if (!argv[i]) throw new Error('Missing value for --backup-dir');
			options.backupDir = String(argv[i]).trim();
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function ensureDir(dirPath) {
	fs.mkdirSync(dirPath, { recursive: true });
}

function sha256File(filePath) {
	const hash = crypto.createHash('sha256');
	const content = fs.readFileSync(filePath);
	hash.update(content);
	return hash.digest('hex');
}

function toRelativePath(fromDir, absolutePath) {
	return path.relative(fromDir, absolutePath).replace(/\\/g, '/');
}

async function getExistingCollectionsSet(db) {
	const rows = await db.listCollections().toArray();
	return new Set(rows.map((item) => item.name));
}

async function getCollectionCounts(db, names, existingSet) {
	const counts = {};

	for (const collectionName of names) {
		if (!existingSet.has(collectionName)) {
			counts[collectionName] = 0;
			continue;
		}
		const count = await db.collection(collectionName).estimatedDocumentCount();
		counts[collectionName] = Number(count || 0);
	}

	return counts;
}

async function exportCollectionToNdjson(db, collectionName, filePath, existingSet) {
	ensureDir(path.dirname(filePath));
	const fd = fs.openSync(filePath, 'w');
	let lineCount = 0;

	try {
		if (existingSet.has(collectionName)) {
			const cursor = db.collection(collectionName).find({});
			for await (const doc of cursor) {
				fs.writeSync(fd, `${EJSON.stringify(doc, { relaxed: false })}\n`);
				lineCount += 1;
			}
		}
	} finally {
		fs.closeSync(fd);
	}

	const stat = fs.statSync(filePath);
	return {
		lineCount,
		bytes: stat.size,
		sha256: sha256File(filePath),
	};
}

function ensureBackupRoot(options, operationTimestamp) {
	const root =
		options.backupDir ?
			path.resolve(process.cwd(), options.backupDir)
		: 	path.join(
				__dirname,
				'..',
				'backups',
				`purge-${operationTimestamp}`,
			);

	if (fs.existsSync(root)) {
		const stat = fs.statSync(root);
		if (!stat.isDirectory()) {
			throw new Error(`Backup path exists and is not a directory: ${root}`);
		}
		const entries = fs.readdirSync(root);
		if (entries.length > 0) {
			throw new Error(`Backup directory must be empty: ${root}`);
		}
	} else {
		ensureDir(root);
	}

	const collectionsDir = path.join(root, 'collections');
	ensureDir(collectionsDir);

	return {
		backupRoot: root,
		collectionsDir,
	};
}

function cleanupQrCodeArtifacts(qrDir) {
	const removed = [];
	if (!fs.existsSync(qrDir)) {
		return removed;
	}

	const patterns = [/^survey-.*\.(png|svg)$/i, /^debug-logo-.*\.(png|svg)$/i];
	for (const entry of fs.readdirSync(qrDir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		if (!patterns.some((pattern) => pattern.test(entry.name))) continue;
		const fullPath = path.join(qrDir, entry.name);
		fs.unlinkSync(fullPath);
		removed.push(fullPath);
	}

	return removed;
}

function cleanupSupportUploads(supportDir) {
	const removed = [];
	if (!fs.existsSync(supportDir)) {
		return removed;
	}

	const walk = (currentDir) => {
		for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			fs.unlinkSync(fullPath);
			removed.push(fullPath);
		}
	};

	walk(supportDir);
	return removed;
}

function normalizeOptionsForLog(options) {
	return {
		mode: options.mode,
		scope: options.scope,
		targetDb: options.targetDb,
		keepAllowlistedAdmins: options.keepAllowlistedAdmins,
		backupDir: options.backupDir || null,
	};
}

function validateOptions(options) {
	if (!options.targetDb) {
		throw new Error('Missing required option: --target-db <dbName>');
	}
	if (options.targetDb !== 'test') {
		throw new Error('Data purge is only allowed on the "test" database.');
	}
	if (options.scope !== DEFAULT_SCOPE) {
		throw new Error(`Unsupported scope: ${options.scope}. Allowed: ${DEFAULT_SCOPE}`);
	}
	if (options.mode === 'execute' && options.confirm !== EXECUTE_CONFIRMATION_TOKEN) {
		throw new Error(
			`Execution requires --confirm ${EXECUTE_CONFIRMATION_TOKEN}`,
		);
	}
}

function buildVerificationErrors(countsAfter, keepUsers, existingSet) {
	const errors = [];

	for (const collectionName of DATA_COLLECTIONS) {
		if (!existingSet.has(collectionName) && collectionName !== USERS_COLLECTION) continue;
		const currentCount = Number(countsAfter[collectionName] || 0);
		if (collectionName === USERS_COLLECTION) {
			if (currentCount !== keepUsers.length) {
				errors.push(
					`${USERS_COLLECTION} count mismatch: expected ${keepUsers.length}, got ${currentCount}`,
				);
			}
			continue;
		}
		if (currentCount !== 0) {
			errors.push(`${collectionName} expected 0, got ${currentCount}`);
		}
	}

	return errors;
}

async function resolveUsersToKeep(options) {
	if (!options.keepAllowlistedAdmins) {
		return {
			allowlistEmails: [],
			keepUsers: [],
		};
	}

	const allowlistEmails = [...new Set(getSupportAdminEmails().map(normalizeEmail))];
	if (allowlistEmails.length === 0) {
		throw new Error(
			'No allowlisted admin/support emails found in SUPPORT_ADMIN_EMAILS or ADMIN_EMAILS.',
		);
	}

	const allowlistSet = new Set(allowlistEmails);
	const users = await User.find({}).select('_id email role').lean();
	const keepUsers = users.filter((user) =>
		allowlistSet.has(normalizeEmail(user.email)),
	);

	if (keepUsers.length === 0) {
		throw new Error(
			'No users matched allowlisted admin/support emails; aborting to prevent lockout.',
		);
	}

	return {
		allowlistEmails,
		keepUsers,
	};
}

async function writeOperationLog(logPath, operation) {
	ensureDir(path.dirname(logPath));
	fs.writeFileSync(logPath, `${JSON.stringify(operation, null, 2)}\n`, 'utf8');
}

async function run() {
	const options = parseArgs(process.argv.slice(2));
	validateOptions(options);

	if (!process.env.MONGO_URI) {
		throw new Error('MONGO_URI is missing in backend/.env');
	}

	const startedAt = new Date();
	const operationTimestamp = timestampForFile();
	const logsDir = path.join(__dirname, '..', 'logs');
	const logPath = path.join(logsDir, `data-purge-${operationTimestamp}.json`);

	const operation = {
		startedAt: startedAt.toISOString(),
		finishedAt: null,
		hostname: os.hostname(),
		options: normalizeOptionsForLog(options),
		mode: options.mode,
		targetDb: options.targetDb,
		dbName: null,
		allowlistEmails: [],
		keepUsers: [],
		countsBefore: {},
		countsAfter: {},
		deletedCounts: {},
		backup: {
			required: options.mode === 'execute',
			rootDir: null,
			manifestPath: null,
			collections: {},
		},
		artifactCleanup: {
			qrCodesRemoved: [],
			supportUploadsRemoved: [],
		},
		verification: {
			success: false,
			errors: [],
		},
		error: null,
	};

	let db = null;
	let existingSet = new Set();

	try {
		await mongoose.connect(process.env.MONGO_URI);
		db = mongoose.connection.db;
		operation.dbName = db.databaseName;

		if (operation.dbName !== options.targetDb) {
			throw new Error(
				`Database guard failed: connected to "${operation.dbName}" but expected "${options.targetDb}".`,
			);
		}

		existingSet = await getExistingCollectionsSet(db);
		operation.countsBefore = await getCollectionCounts(
			db,
			DATA_COLLECTIONS,
			existingSet,
		);

		const { allowlistEmails, keepUsers } = await resolveUsersToKeep(options);
		operation.allowlistEmails = allowlistEmails;
		operation.keepUsers = keepUsers.map((user) => ({
			id: String(user._id),
			email: user.email || null,
			role: user.role || null,
		}));

		if (options.mode === 'dry-run') {
			operation.countsAfter = { ...operation.countsBefore };
			operation.verification.success = true;
			console.log('Dry-run complete. No data was deleted.');
			return operation;
		}

		const { backupRoot, collectionsDir } = ensureBackupRoot(
			options,
			operationTimestamp,
		);
		operation.backup.rootDir = backupRoot;

		for (const collectionName of DATA_COLLECTIONS) {
			const filePath = path.join(collectionsDir, `${collectionName}.ndjson`);
			const stats = await exportCollectionToNdjson(
				db,
				collectionName,
				filePath,
				existingSet,
			);
			operation.backup.collections[collectionName] = {
				file: toRelativePath(backupRoot, filePath),
				lineCount: stats.lineCount,
				bytes: stats.bytes,
				sha256: stats.sha256,
			};
		}

		const keepUserIds = keepUsers.map((user) => user._id);

		for (const collectionName of PURGE_ORDER) {
			if (collectionName === 'users') {
				const result = await User.deleteMany({
					_id: { $nin: keepUserIds },
				});
				operation.deletedCounts.users = Number(result.deletedCount || 0);
				continue;
			}

			if (!existingSet.has(collectionName)) {
				operation.deletedCounts[collectionName] = 0;
				continue;
			}

			const result = await db.collection(collectionName).deleteMany({});
			operation.deletedCounts[collectionName] = Number(result.deletedCount || 0);
		}

		const qrDir = getUploadsSubdir('qrcodes');
		const supportDir = getUploadsSubdir('support');
		operation.artifactCleanup.qrCodesRemoved = cleanupQrCodeArtifacts(qrDir).map(
			(filePath) => toRelativePath(path.join(__dirname, '..'), filePath),
		);
		operation.artifactCleanup.supportUploadsRemoved = cleanupSupportUploads(
			supportDir,
		).map((filePath) => toRelativePath(path.join(__dirname, '..'), filePath));

		operation.countsAfter = await getCollectionCounts(db, DATA_COLLECTIONS, existingSet);

		const usersAfter = await User.find({ _id: { $in: keepUserIds } })
			.select('_id')
			.lean();
		if (usersAfter.length !== keepUsers.length) {
			operation.verification.errors.push(
				`keepUsers integrity mismatch: expected ${keepUsers.length}, found ${usersAfter.length}`,
			);
		}

		operation.verification.errors.push(
			...buildVerificationErrors(operation.countsAfter, keepUsers, existingSet),
		);
		operation.verification.success = operation.verification.errors.length === 0;

		const manifestPath = path.join(backupRoot, 'manifest.json');
		const manifest = {
			generatedAt: new Date().toISOString(),
			hostname: os.hostname(),
			dbName: operation.dbName,
			targetDb: options.targetDb,
			mode: options.mode,
			scope: options.scope,
			keepAllowlistedAdmins: options.keepAllowlistedAdmins,
			allowlistEmails,
			keepUsers: operation.keepUsers,
			countsBefore: operation.countsBefore,
			countsAfter: operation.countsAfter,
			collections: operation.backup.collections,
			artifactCleanup: operation.artifactCleanup,
		};
		fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
		operation.backup.manifestPath = manifestPath;

		if (!operation.verification.success) {
			throw new Error(
				`Post-purge verification failed (${operation.verification.errors.length} issue(s)).`,
			);
		}

		console.log('Purge completed successfully.');
		return operation;
	} catch (error) {
		operation.error = {
			message: error.message,
			stack: error.stack || null,
		};
		throw { error, operation, logPath };
	} finally {
		operation.finishedAt = new Date().toISOString();
		await writeOperationLog(logPath, operation);
		if (mongoose.connection.readyState !== 0) {
			await mongoose.connection.close();
		}
		console.log(`Operation log written: ${logPath}`);
	}
}

run().catch((payload) => {
	const error = payload?.error || payload;
	console.error(error?.message || String(error));
	process.exitCode = 1;
});

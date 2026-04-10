/** @format */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const { RESTORE_ORDER } = require('./environment-data-collections');

require('dotenv').config({
	path: path.join(__dirname, '..', '.env'),
	quiet: true,
});

const RESTORE_CONFIRMATION_TOKEN = 'RESTORE_DATA';

function timestampForFile() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
	const options = {
		mode: 'dry-run',
		manifestPath: '',
		confirm: '',
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
		if (arg === '--manifest') {
			const nextValue = argv[i + 1];
			if (!nextValue || String(nextValue).startsWith('--')) {
				continue;
			}
			i += 1;
			options.manifestPath = String(argv[i]).trim();
			continue;
		}
		if (arg === '--confirm') {
			i += 1;
			if (!argv[i]) throw new Error('Missing value for --confirm');
			options.confirm = String(argv[i]).trim();
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!options.manifestPath) {
		throw new Error('Missing required option: --manifest <path>');
	}

	if (options.mode === 'execute' && options.confirm !== RESTORE_CONFIRMATION_TOKEN) {
		throw new Error(
			`Execution requires --confirm ${RESTORE_CONFIRMATION_TOKEN}`,
		);
	}

	return options;
}

function ensureDir(dirPath) {
	fs.mkdirSync(dirPath, { recursive: true });
}

function sha256File(filePath) {
	const hash = crypto.createHash('sha256');
	hash.update(fs.readFileSync(filePath));
	return hash.digest('hex');
}

function readManifest(absoluteManifestPath) {
	if (!fs.existsSync(absoluteManifestPath)) {
		throw new Error(`Manifest file not found: ${absoluteManifestPath}`);
	}
	const stat = fs.statSync(absoluteManifestPath);
	if (!stat.isFile()) {
		throw new Error(`Manifest path is not a file: ${absoluteManifestPath}`);
	}

	const manifest = JSON.parse(fs.readFileSync(absoluteManifestPath, 'utf8'));
	if (!manifest || typeof manifest !== 'object') {
		throw new Error('Invalid manifest JSON payload.');
	}
	if (!manifest.dbName) {
		throw new Error('Manifest is missing dbName.');
	}
	if (manifest.dbName !== 'test') {
		throw new Error('Restore is only allowed for backups targeting the "test" database.');
	}
	if (!manifest.collections || typeof manifest.collections !== 'object') {
		throw new Error('Manifest is missing collections metadata.');
	}
	return manifest;
}

function readCollectionDocsFromNdjson(filePath) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Backup data file not found: ${filePath}`);
	}
	const raw = fs.readFileSync(filePath, 'utf8');
	if (!raw.trim()) return [];

	return raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => EJSON.parse(line, { relaxed: false }));
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

async function writeLog(logPath, payload) {
	ensureDir(path.dirname(logPath));
	fs.writeFileSync(logPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function run() {
	const options = parseArgs(process.argv.slice(2));
	if (!process.env.MONGO_URI) {
		throw new Error('MONGO_URI is missing in backend/.env');
	}

	const operationTimestamp = timestampForFile();
	const logPath = path.join(
		__dirname,
		'..',
		'logs',
		`data-restore-${operationTimestamp}.json`,
	);
	const absoluteManifestPath = path.resolve(process.cwd(), options.manifestPath);
	const manifest = readManifest(absoluteManifestPath);
	const backupRoot = path.dirname(absoluteManifestPath);

	const operation = {
		startedAt: new Date().toISOString(),
		finishedAt: null,
		hostname: os.hostname(),
		mode: options.mode,
		manifestPath: absoluteManifestPath,
		dbName: null,
		manifestDbName: manifest.dbName,
		checksumValidation: {
			success: false,
			errors: [],
			files: {},
		},
		countsBefore: {},
		countsAfter: {},
		deletedCounts: {},
		insertedCounts: {},
		verification: {
			success: false,
			errors: [],
		},
		error: null,
	};

	try {
		const backupCollections = manifest.collections;
		for (const collectionName of RESTORE_ORDER) {
			const meta = backupCollections[collectionName];
			if (!meta) {
				operation.checksumValidation.errors.push(
					`Missing collection metadata in manifest: ${collectionName}`,
				);
				continue;
			}

			const relativeFilePath = String(meta.file || '');
			if (!relativeFilePath) {
				operation.checksumValidation.errors.push(
					`Missing backup file path for collection: ${collectionName}`,
				);
				continue;
			}

			const absoluteFilePath = path.resolve(backupRoot, relativeFilePath);
			if (!fs.existsSync(absoluteFilePath)) {
				operation.checksumValidation.errors.push(
					`Backup file not found for ${collectionName}: ${absoluteFilePath}`,
				);
				continue;
			}

			const actualSha = sha256File(absoluteFilePath);
			const expectedSha = String(meta.sha256 || '').trim();
			if (!expectedSha) {
				operation.checksumValidation.errors.push(
					`Missing sha256 in manifest for collection: ${collectionName}`,
				);
				continue;
			}
			if (actualSha !== expectedSha) {
				operation.checksumValidation.errors.push(
					`Checksum mismatch for ${collectionName}: expected ${expectedSha}, got ${actualSha}`,
				);
				continue;
			}

			operation.checksumValidation.files[collectionName] = {
				file: absoluteFilePath,
				sha256: actualSha,
			};
		}

		operation.checksumValidation.success =
			operation.checksumValidation.errors.length === 0;

		if (!operation.checksumValidation.success) {
			throw new Error(
				`Checksum validation failed (${operation.checksumValidation.errors.length} issue(s)).`,
			);
		}

		await mongoose.connect(process.env.MONGO_URI);
		const db = mongoose.connection.db;
		operation.dbName = db.databaseName;

		if (operation.dbName !== manifest.dbName) {
			throw new Error(
				`Database guard failed: connected to "${operation.dbName}" but manifest targets "${manifest.dbName}".`,
			);
		}

		const existingBefore = await getExistingCollectionsSet(db);
		operation.countsBefore = await getCollectionCounts(
			db,
			RESTORE_ORDER,
			existingBefore,
		);

		if (options.mode === 'dry-run') {
			operation.countsAfter = { ...operation.countsBefore };
			operation.verification.success = true;
			console.log('Restore dry-run complete. No data was changed.');
			return operation;
		}

		for (const collectionName of RESTORE_ORDER) {
			const result = await db.collection(collectionName).deleteMany({});
			operation.deletedCounts[collectionName] = Number(result.deletedCount || 0);
		}

		for (const collectionName of RESTORE_ORDER) {
			const meta = manifest.collections[collectionName];
			const absoluteFilePath = path.resolve(backupRoot, String(meta.file || ''));
			const docs = readCollectionDocsFromNdjson(absoluteFilePath);
			if (docs.length === 0) {
				operation.insertedCounts[collectionName] = 0;
				continue;
			}

			const result = await db.collection(collectionName).insertMany(docs, {
				ordered: true,
			});
			operation.insertedCounts[collectionName] = Object.keys(result.insertedIds).length;
		}

		const existingAfter = await getExistingCollectionsSet(db);
		operation.countsAfter = await getCollectionCounts(db, RESTORE_ORDER, existingAfter);

		const expectedCounts = manifest.countsBefore || {};
		for (const collectionName of RESTORE_ORDER) {
			const expected = Number(expectedCounts[collectionName] || 0);
			const actual = Number(operation.countsAfter[collectionName] || 0);
			if (actual !== expected) {
				operation.verification.errors.push(
					`${collectionName} count mismatch: expected ${expected}, got ${actual}`,
				);
			}
		}

		operation.verification.success = operation.verification.errors.length === 0;
		if (!operation.verification.success) {
			throw new Error(
				`Restore verification failed (${operation.verification.errors.length} issue(s)).`,
			);
		}

		console.log('Restore completed successfully.');
		return operation;
	} catch (error) {
		operation.error = {
			message: error.message,
			stack: error.stack || null,
		};
		throw { error, operation, logPath };
	} finally {
		operation.finishedAt = new Date().toISOString();
		await writeLog(logPath, operation);
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

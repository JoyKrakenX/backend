/** @format */

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
	googleId: { type: String, required: true, unique: true },

	email: { type: String, required: true, unique: true },

	name: { type: String },
	picture: { type: String },
	role: {
		type: String,
		enum: ['user', 'support', 'admin'],
		default: 'user',
		index: true,
	},

	pseudo: {
		type: String,
		unique: true,
		sparse: true,
		trim: true,
	},
	birthdate: {
		type: Date,
	},
	gender: {
		type: String,
		enum: ['homme', 'femme'],
	},
	defaultOrganizationId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'Organization',
		default: null,
		index: true,
	},
	createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);

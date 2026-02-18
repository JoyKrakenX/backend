/** @format */

module.exports = (...allowedRoles) => {
	const rolesSet = new Set(allowedRoles);

	return (req, res, next) => {
		const userRole = req.userRole || req.user?.role || 'user';
		if (!rolesSet.has(userRole)) {
			return res.status(403).json({ message: 'Accès refusé.' });
		}
		return next();
	};
};


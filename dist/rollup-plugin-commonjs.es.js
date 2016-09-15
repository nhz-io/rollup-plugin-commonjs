import { statSync } from 'fs';
import * as fs from 'fs';
import { basename, dirname, extname, resolve, sep } from 'path';
import { sync } from 'resolve';
import { attachScopes, createFilter, makeLegalIdentifier } from 'rollup-pluginutils';
import acorn from 'acorn';
import { walk } from 'estree-walker';
import MagicString from 'magic-string';

var HELPERS_ID = '\0commonjsHelpers';

var HELPERS = "\nexport var commonjsGlobal = typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};\n\nexport function unwrapExports (x) {\n\treturn x && x.__esModule ? x['default'] : x;\n}\n\nexport function createCommonjsModule(fn, module) {\n\treturn module = { exports: {} }, fn(module, module.exports), module.exports;\n}";

var PREFIX = '\0commonjs-proxy:';
var EXTERNAL = '\0commonjs-external:';

function isFile ( file ) {
	try {
		var stats = statSync( file );
		return stats.isFile();
	} catch ( err ) {
		return false;
	}
}

function addJsExtensionIfNecessary ( file ) {
	if ( isFile( file ) ) return file;

	file += '.js';
	if ( isFile( file ) ) return file;

	return null;
}

var absolutePath = /^(?:\/|(?:[A-Za-z]:)?[\\|\/])/;

function isAbsolute ( path$$1 ) {
	return absolutePath.test( path$$1 );
}

function defaultResolver ( importee, importer ) {
	// absolute paths are left untouched
	if ( isAbsolute( importee ) ) return addJsExtensionIfNecessary( resolve( importee ) );

	// if this is the entry point, resolve against cwd
	if ( importer === undefined ) return addJsExtensionIfNecessary( resolve( process.cwd(), importee ) );

	// external modules are skipped at this stage
	if ( importee[0] !== '.' ) return null;

	return addJsExtensionIfNecessary( resolve( dirname( importer ), importee ) );
}

function isReference ( node, parent ) {
	if ( parent.type === 'MemberExpression' ) return parent.computed || node === parent.object;

	// disregard the `bar` in { bar: foo }
	if ( parent.type === 'Property' && node !== parent.value ) return false;

	// disregard the `bar` in `class Foo { bar () {...} }`
	if ( parent.type === 'MethodDefinition' ) return false;

	// disregard the `bar` in `export { foo as bar }`
	if ( parent.type === 'ExportSpecifier' && node !== parent.local ) return false;

	return true;
}

function flatten ( node ) {
	var parts = [];

	while ( node.type === 'MemberExpression' ) {
		if ( node.computed ) return null;

		parts.unshift( node.property.name );
		node = node.object;
	}

	if ( node.type !== 'Identifier' ) return null;

	var name = node.name;
	parts.unshift( name );

	return { name: name, keypath: parts.join( '.' ) };
}

function isTruthy ( node ) {
	if ( node.type === 'Literal' ) return !!node.value;
	if ( node.type === 'ParenthesizedExpression' ) return isTruthy( node.expression );
	if ( node.operator in operators ) return operators[ node.operator ]( node );
}

function isFalsy ( node ) {
	return not( isTruthy( node ) );
}

function not ( value ) {
	return value === undefined ? value : !value;
}

function equals ( a, b, strict ) {
	if ( a.type !== b.type ) return undefined;
	if ( a.type === 'Literal' ) return strict ? a.value === b.value : a.value == b.value;
}

var operators = {
	'==': function (x) {
		return equals( x.left, x.right, false );
	},

	'!=': function (x) { return not( operators['==']( x ) ); },

	'===': function (x) {
		return equals( x.left, x.right, true );
	},

	'!==': function (x) { return not( operators['===']( x ) ); },

	'!': function (x) { return isFalsy( x.argument ); },

	'&&': function (x) { return isTruthy( x.left ) && isTruthy( x.right ); },

	'||': function (x) { return isTruthy( x.left ) || isTruthy( x.right ); }
};

function getName ( id ) {
	return makeLegalIdentifier( basename( id, extname( id ) ) );
}

var reserved = 'abstract arguments boolean break byte case catch char class const continue debugger default delete do double else enum eval export extends false final finally float for function goto if implements import in instanceof int interface let long native new null package private protected public return short static super switch synchronized this throw throws transient true try typeof var void volatile while with yield'.split( ' ' );
var blacklistedExports = { __esModule: true };
reserved.forEach( function (word) { return blacklistedExports[ word ] = true; } );

var exportsPattern = /^(?:module\.)?exports(?:\.([a-zA-Z_$][a-zA-Z_$0-9]*))?$/;

var firstpassGlobal = /\b(?:require|module|exports|global)\b/;
var firstpassNoGlobal = /\b(?:require|module|exports)\b/;

function deconflict ( identifier, code ) {
	var i = 1;
	var deconflicted = identifier;

	while ( ~code.indexOf( deconflicted ) ) deconflicted = identifier + "_" + (i++);
	return deconflicted;
}

function tryParse ( code, id ) {
	code = code.replace(/^\s*#.*/g, ''); // Strip shebang-like junk
	
	try {
		return acorn.parse( code, {
			ecmaVersion: 6,
			sourceType: 'module'
		});
	} catch ( err ) {
		err.message += " in " + id;
		throw err;
	}
}

function transform ( code, id, isEntry, ignoreGlobal, customNamedExports, sourceMap ) {
	var firstpass = ignoreGlobal ? firstpassNoGlobal : firstpassGlobal;
	if ( !firstpass.test( code ) ) return null;

	var namedExports = {};
	if ( customNamedExports ) customNamedExports.forEach( function (name) { return namedExports[ name ] = true; } );

	var ast = tryParse( code, id );
	var magicString = new MagicString( code );

	var required = {};
	// Because objects have no guaranteed ordering, yet we need it,
	// we need to keep track of the order in a array
	var sources = [];

	var uid = 0;

	var scope = attachScopes( ast, 'scope' );
	var uses = { module: false, exports: false, global: false };

	var scopeDepth = 0;

	var HELPERS_NAME = deconflict( 'commonjsHelpers', code );

	walk( ast, {
		enter: function enter ( node, parent ) {
			// skip dead branches
			if ( parent && ( parent.type === 'IfStatement' || parent.type === 'ConditionalExpression' ) ) {
				if ( node === parent.consequent && isFalsy( parent.test ) ) return this.skip();
				if ( node === parent.alternate && isTruthy( parent.test ) ) return this.skip();
			}

			if ( node.scope ) scope = node.scope;
			if ( /^Function/.test( node.type ) ) scopeDepth += 1;

			if ( sourceMap ) {
				magicString.addSourcemapLocation( node.start );
				magicString.addSourcemapLocation( node.end );
			}

			// Is this an assignment to exports or module.exports?
			if ( node.type === 'AssignmentExpression' ) {
				if ( node.left.type !== 'MemberExpression' ) return;

				var flattened = flatten( node.left );
				if ( !flattened ) return;

				if ( scope.contains( flattened.name ) ) return;

				var match = exportsPattern.exec( flattened.keypath );
				if ( !match || flattened.keypath === 'exports' ) return;

				if ( flattened.keypath === 'module.exports' && node.right.type === 'ObjectExpression' ) {
					return node.right.properties.forEach( function (prop) {
						if ( prop.computed || prop.key.type !== 'Identifier' ) return;
						var name = prop.key.name;
						if ( name === makeLegalIdentifier( name ) ) namedExports[ name ] = true;
					});
				}

				if ( match[1] ) namedExports[ match[1] ] = true;

				return;
			}

			// To allow consumption of UMD modules, transform `typeof require` to `'function'`
			if ( node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument.type === 'Identifier' ) {
				var name$1 = node.argument.name;

				if ( name$1 === 'require' && !scope.contains( name$1 ) ) {
					magicString.overwrite( node.start, node.end, "'function'" );
					return;
				}
			}

			if ( node.type === 'Identifier' ) {
				if ( ( node.name in uses ) && isReference( node, parent ) && !scope.contains( node.name ) ) {
					uses[ node.name ] = true;
					if ( node.name === 'global' && !ignoreGlobal ) magicString.overwrite( node.start, node.end, (HELPERS_NAME + ".commonjsGlobal") );
				}
				return;
			}

			if ( node.type === 'ThisExpression' && scopeDepth === 0 && !ignoreGlobal ) {
				uses.global = true;
				if ( !ignoreGlobal ) magicString.overwrite( node.start, node.end, (HELPERS_NAME + ".commonjsGlobal"), true );
				return;
			}

			if ( node.type !== 'CallExpression' ) return;
			if ( node.callee.name !== 'require' || scope.contains( 'require' ) ) return;
			if ( node.arguments.length !== 1 || node.arguments[0].type !== 'Literal' ) return; // TODO handle these weird cases?

			var source = node.arguments[0].value;

			var existing = required[ source ];
			if ( existing === undefined ) {
				sources.unshift(source);
			}
			var name;

			if ( !existing ) {
				name = "require$$" + (uid++);
				required[ source ] = { source: source, name: name, importsDefault: false };
			} else {
				name = required[ source ].name;
			}

			if ( parent.type !== 'ExpressionStatement' ) {
				required[ source ].importsDefault = true;
				magicString.overwrite( node.start, node.end, name );
			} else {
				// is a bare import, e.g. `require('foo');`
				magicString.remove( parent.start, parent.end );
			}
		},

		leave: function leave ( node ) {
			if ( node.scope ) scope = scope.parent;
			if ( /^Function/.test( node.type ) ) scopeDepth -= 1;
		}
	});

	if ( !sources.length && !uses.module && !uses.exports && ( ignoreGlobal || !uses.global ) ) {
		if ( Object.keys( namedExports ).length ) {
			throw new Error( ("Custom named exports were specified for " + id + " but it does not appear to be a CommonJS module") );
		}
		return null; // not a CommonJS module
	}

	var importBlock = [ ("import * as " + HELPERS_NAME + " from '" + HELPERS_ID + "';") ].concat(
		sources.map( function (source) {
			// import the actual module before the proxy, so that we know
			// what kind of proxy to build
			return ("import '" + source + "';");
		}),
		sources.map( function (source) {
			var ref = required[ source ];
			var name = ref.name;
			var importsDefault = ref.importsDefault;
			return ("import " + (importsDefault ? (name + " from ") : "") + "'" + PREFIX + source + "';");
		})
	).join( '\n' );

	var args = "module" + (uses.exports ? ', exports' : '');

	var name = getName( id );

	var wrapperStart = "\n\nvar " + name + " = " + HELPERS_NAME + ".createCommonjsModule(function (" + args + ") {\n";
	var wrapperEnd = "\n});\n\n";

	var exportBlock = ( isEntry ? [] : [ ("export { " + name + " as __moduleExports };") ] ).concat(
		/__esModule/.test( code ) ? ("export default " + HELPERS_NAME + ".unwrapExports(" + name + ");\n") : ("export default " + name + ";\n"),
		Object.keys( namedExports )
			.filter( function (key) { return !blacklistedExports[ key ]; } )
			.map( function (x) {
				if (x === name) {
					return ("var " + x + "$$1 = " + name + "." + x + ";\nexport { " + x + "$$1 as " + x + " };");
				} else {
					return ("export var " + x + " = " + name + "." + x + ";");
				}
			})
	).join( '\n' );

	magicString.trim()
		.prepend( importBlock + wrapperStart )
		.trim()
		.append( wrapperEnd + exportBlock );

	code = magicString.toString();
	var map = sourceMap ? magicString.generateMap() : null;

	return { code: code, map: map };
}

function getCandidatesForExtension ( resolved, extension ) {
	return [
		resolved + extension,
		resolved + sep + "index" + extension
	];
}

function getCandidates ( resolved, extensions ) {
	return extensions.reduce(
		function ( paths, extension ) { return paths.concat( getCandidatesForExtension ( resolved, extension ) ); },
		[resolved]
	);
}

// Return the first non-falsy result from an array of
// maybe-sync, maybe-promise-returning functions
function first ( candidates ) {
	return function () {
		var args = [], len = arguments.length;
		while ( len-- ) args[ len ] = arguments[ len ];

		return candidates.reduce( function ( promise, candidate ) {
			return promise.then( function (result) { return result != null ?
				result :
				Promise.resolve( candidate.apply( void 0, args ) ); } );
		}, Promise.resolve() );
	};
}

function startsWith ( str, prefix ) {
	return str.slice( 0, prefix.length ) === prefix;
}


function commonjs ( options ) {
	if ( options === void 0 ) options = {};

	var extensions = options.extensions || ['.js'];
	var filter = createFilter( options.include, options.exclude );
	var ignoreGlobal = options.ignoreGlobal;

	var customNamedExports = {};
	if ( options.namedExports ) {
		Object.keys( options.namedExports ).forEach( function (id) {
			var resolvedId;

			try {
				resolvedId = sync( id, { basedir: process.cwd() });
			} catch ( err ) {
				resolvedId = resolve( id );
			}

			customNamedExports[ resolvedId ] = options.namedExports[ id ];
		});
	}

	var entryModuleIdPromise = null;
	var entryModuleId = null;

	function resolveId ( importee, importer ) {
		if ( importee === HELPERS_ID ) return importee;

		if ( importer && startsWith( importer, PREFIX ) ) importer = importer.slice( PREFIX.length );

		var isProxyModule = startsWith( importee, PREFIX );
		if ( isProxyModule ) importee = importee.slice( PREFIX.length );

		return resolveUsingOtherResolvers( importee, importer ).then( function (resolved) {
			if ( resolved ) return isProxyModule ? PREFIX + resolved : resolved;

			resolved = defaultResolver( importee, importer );

			if ( isProxyModule ) {
				if ( resolved ) return PREFIX + resolved;
				return EXTERNAL + importee; // external
			}

			return resolved;
		});
	}

	var sourceMap = options.sourceMap !== false;

	var commonjsModules = new Map();
	var resolveUsingOtherResolvers;

	return {
		name: 'commonjs',

		options: function options$1 ( options ) {
			var resolvers = ( options.plugins || [] )
				.map( function (plugin) {
					if ( plugin.resolveId === resolveId ) {
						// substitute CommonJS resolution logic
						return function ( importee, importer ) {
							if ( importee[0] !== '.' || !importer ) return; // not our problem

							var resolved = resolve( dirname( importer ), importee );
							var candidates = getCandidates( resolved, extensions );

							for ( var i = 0; i < candidates.length; i += 1 ) {
								try {
									var stats = statSync( candidates[i] );
									if ( stats.isFile() ) return candidates[i];
								} catch ( err ) { /* noop */ }
							}
						};
					}

					return plugin.resolveId;
				})
				.filter( Boolean );

			resolveUsingOtherResolvers = first( resolvers );

			entryModuleIdPromise = resolveId( options.entry ).then( function (resolved) {
				entryModuleId = resolved;
			});
		},

		resolveId: resolveId,

		load: function load ( id ) {
			if ( id === HELPERS_ID ) return HELPERS;

			// generate proxy modules
			if ( startsWith( id, EXTERNAL ) ) {
				var actualId = id.slice( EXTERNAL.length );
				var name = getName( actualId );

				return ("import " + name + " from " + (JSON.stringify( actualId )) + "; export default " + name + ";");
			}

			if ( startsWith( id, PREFIX ) ) {
				var actualId$1 = id.slice( PREFIX.length );
				var name$1 = getName( actualId$1 );

				return commonjsModules.has( actualId$1 ) ?
					("import { __moduleExports } from " + (JSON.stringify( actualId$1 )) + "; export default __moduleExports;") :
					("import * as " + name$1 + " from " + (JSON.stringify( actualId$1 )) + "; export default ( " + name$1 + " && " + name$1 + "['default'] ) || " + name$1 + ";");
			}
		},

		transform: function transform$1 ( code, id ) {
			if ( !filter( id ) ) return null;
			if ( extensions.indexOf( extname( id ) ) === -1 ) return null;

			return entryModuleIdPromise.then( function () {
				var transformed = transform( code, id, id === entryModuleId, ignoreGlobal, customNamedExports[ id ], sourceMap );

				if ( transformed ) {
					commonjsModules.set( id, true );
					return transformed;
				}
			});
		}
	};
}

export default commonjs;
//# sourceMappingURL=rollup-plugin-commonjs.es.js.map
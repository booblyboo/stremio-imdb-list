
const { config } = require('internal')

const { addonBuilder, getRouter } = require('stremio-addon-sdk')

const manifest = {
	id: 'org.imdblist_local',
	version: '0.0.1',
	name: 'IMDB List Add-on',
	description: 'Add-on to create a catalog from IMDB lists.',
	resources: ['catalog'],
	types: ['movie', 'series'],
	catalogs: [
		{
			id: 'imdb-movie-list',
			name: 'IMDB Movie List',
			type: 'movie'
		}, {
			id: 'imdb-series-list',
			name: 'IMDB Series List',
			type: 'series'
		}
	]
}

const listManifest = {}

const needle = require('needle')

const headers = {
	'User-Agent': 'Mozilla/5.0 (Linux; Android 8.0.0; TA-1053 Build/OPR1.170623.026) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/67.0.3368.0 Mobile Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.8',
}

function imageResize(posterUrl, width) {
	if (!posterUrl) return null
	if (!posterUrl.includes('amazon.com') && !posterUrl.includes('imdb.com')) return posterUrl
	if (posterUrl.includes('._V1_.')) posterUrl = posterUrl.replace('._V1_.', '._V1_SX' + width + '.')
	else if (posterUrl.includes('._V1_')) {
		var extension = posterUrl.split('.').pop()
		posterUrl = posterUrl.substr(0,posterUrl.indexOf('._V1_')) + '._V1_SX' + width + '.' + extension
	}
	return posterUrl
}

function toMeta(obj) {
	const titleYear = obj.primary.year && obj.primary.year[0] ? obj.primary.year.length > 1 ? ' (' + obj.primary.year[0] + '-' + obj.primary.year[1] + ')' : ' (' + obj.primary.year[0] + ')' : ''
	return {
		id: obj.id || null,
		name: obj.primary && obj.primary.title ? obj.primary.title + (titleYear || '') : null,
		poster: obj.poster && obj.poster.url ? imageResize(obj.poster.url, 250) : null,
		type: obj.type == 'featureFilm' ? 'movie' : 'series'
	}
}

const sorts = {
	'List Order': 'list_order%2Casc',
	'Popularity': 'moviemeter%2Casc',
	'Alphabetical': 'alpha%2Casc',
	'Rating': 'user_rating%2Cdesc',
	'Votes': 'num_votes%2Cdesc',
	'Release': 'release_date%2Cdesc',
	'Date Added': 'date_added%2Cdesc'
}

function getList(listId, sort, cb) {
	if (listId) {
		headers.referer = 'https://m.imdb.com/list/'+listId+'/'
		const getUrl = 'https://m.imdb.com/list/'+listId+'/search?sort='+sorts[sort]+'&view=grid&tracking_tag=&pageId='+listId+'&pageType=list'
		needle.get(getUrl, { headers }, (err, resp) => {
			if (!err && resp && resp.body) {
				const cacheTag = listId + '[]' + sort
				const jObj = resp.body
				if (jObj.titles && Object.keys(jObj.titles).length) {
					manifest.types.forEach(el => { cache[el][cacheTag] = [] })
					for (let key in jObj.titles) {
						const el = jObj.titles[key]
						const metaType = el.type == 'featureFilm' ? 'movie' : el.type == 'series' ? 'series' : null
						if (metaType) {
							cache[metaType][cacheTag].push(toMeta(el))
						}
					}
					if (jObj.list && jObj.list.name) {
						const cloneManifest = JSON.parse(JSON.stringify(manifest))
						cloneManifest.id = 'org.imdblist' + cacheTag
						cloneManifest.name = jObj.list.name + ' by ' + sort
						cloneManifest.catalogs.forEach((cat, ij) => {
							cloneManifest.catalogs[ij].name = jObj.list.name + ' by ' + sort
						})
						listManifest[cacheTag] = cloneManifest
					}
					setTimeout(() => {
						manifest.types.forEach(el => { cache[el][cacheTag] = [] })
					}, 86400000)
					cb(false, true)
				} else 
					cb('Parsing error on ajax call')
			} else
				cb(err || 'Error on requesting ajax call')
		})
	} else
		cb('No list id')
}

const namedQueue = require('named-queue')

const queue = new namedQueue((task, cb) => {
	const id = task.id.split('[]')[0]
	const sort = task.id.split('[]')[1]
	getList(id, sort, cb)
}, Infinity)

const cache = { movie: {}, series: {} }

function retrieveManifest() {
	return new Promise((resolve, reject) => {
		const cacheTag = listId + '[]' + config.sort
		function tryRespond() {
			if (listManifest[cacheTag]) {
				resolve(listManifest[cacheTag])
				return true
			} else
				return false
		}
		const responded = tryRespond()
		if (!responded) {
			queue.push({ id: cacheTag }, (err, done) => {
				if (done) {
					const tryAgain = tryRespond()
					if (tryAgain)
						return
				}
				resolve(manifest)
			})
		}
	})
}

let listId = ''

async function retrieveRouter() {
	return new Promise(async (resolve, reject) => {
		if (!config.listUrl) {
			reject(Error('IMDB List Add-on - No List Url'))
			return
		} else {
			if (!config.listUrl.includes('.imdb.com/list/')) {
				// https://www.imdb.com/list/ls047677021/
				reject(Error('IMDB List Add-on - Invalid IMDB List URL, it should be in the form of: https://www.imdb.com/list/ls047677021/'))
				return
			} else {
				let tempId = config.listUrl.split('/list/')[1]
				if (tempId.includes('/'))
					tempId = tempId.split('/')[0]
				listId = tempId
			}
		}
		const manifest = await retrieveManifest()
		const builder = new addonBuilder(manifest)
		builder.defineCatalogHandler(args => {
			return new Promise((resolve, reject) => {
				const cacheTag = listId + '[]' + (config.sort || 'list_order')
				function fetch() {
					queue.push({ id: cacheTag }, (err, done) => {
						if (done) {
							const userData = cache[args.type][cacheTag]
							resolve({ metas: userData, cacheMaxAge: 86400 }) // one day
						} else 
							reject(err || Error('Could not get list items'))
					})
				}
				if (listId && ['movie','series'].indexOf(args.type) > -1) {
					if (cache[args.type][cacheTag]) {
						const userData = cache[args.type][cacheTag]
						if (userData.length)
							resolve({ metas: userData, cacheMaxAge: 86400 }) // one day
						else
							fetch()
					} else
						fetch()
				} else
					reject(Error('Unknown request parameters'))
			})
		})

		resolve(getRouter(builder.getInterface()))
	})
}

module.exports = retrieveRouter()

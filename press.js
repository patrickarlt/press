var _ = require('lodash');
var glob = require('glob');
var async = require('async');
var fs = require('fs');
var path = require('path');
var yaml = require('js-yaml');
var nunjucks  = require('nunjucks');
var marked = require('marked');
var Gaze = require('gaze').Gaze;
var fse = require('fs-extra');
var minimatch = require('minimatch');

var PressTemplateLoader = require('./lib/press-loader');
var markdownHelpers = require('./lib/extensions/markdown-helpers');
var metadataInjector = require('./lib/extensions/metadata');
var collection = require('./lib/extensions/collection');
var dataInjector = require('./lib/extensions/data');
var statsInjector = require('./lib/extensions/stats');
var codeHighlighting = require('./lib/extensions/code-highlighting');
var prettyUrls = require('./lib/extensions/pretty-urls');
var pressUtils = require('./lib/utils');
var relativeUrls = require('./lib/extensions/relative-path');
var Page = require('./lib/page');

var markdownExt = /\.(md|markdown)/;
var pageGlob = '**/*.+(md|markdown|html)';
var dataGlob = '**/*.+(js|json|yaml|yml)';

function Press(options){
  this.config = _.defaults(options, {
    dest: 'build',
    src: 'src',
    data: 'data',
    metadataBuffer: 1024,
    root: process.cwd(),
    nunjucks: {},
    marked: {}
  });

  _.bindAll(this);

  this.runningExtension = false;

  this._extensions = [];
  this.pages = [];
  this.collections = {};
  this.globals = {};

  this.marked = marked;
  marked.setOptions(this.config.marked);

  this._nunjucksTemplateLoader = new PressTemplateLoader({
    templates: path.join(this.config.root, this.config.src),
  });

  this.nunjucks = new nunjucks.Environment(this._nunjucksTemplateLoader, this.config.nunjucks);
}

/**
 * Press Watcher
 */

Press.prototype._invalidateNunjucksCache = function(filepath){
  var name = filepath.replace(this.config.src + path.sep, '').replace(path.extname(filepath), '');
  console.log('invalidate', name);
  this._nunjucksTemplateLoader.emit('update', name);
};

Press.prototype.startWatcher = function(){
  var pageMatcher = path.join(this.config.src, pageGlob);
  var dataMatcher = path.join(this.config.data, dataGlob);

  this.watcher = new Gaze([pageMatcher, dataMatcher]);

  this.watcher.on('renamed', _.bind(function(filepath, oldpath){
    filepath = filepath.replace(process.cwd() + path.sep, '');
    oldpath = (oldpath) ? oldpath.replace(process.cwd() + path.sep, '') : undefined;

    if(!minimatch(filepath, pageMatcher) && minimatch(oldpath, pageMatcher)){
      console.log('handle page rename like delete');
      this._invalidateNunjucksCache(oldpath);
      this.handlePageDelete(oldpath);
    } else if(minimatch(filepath, pageMatcher)) {
      console.log('handle page rename');
      this._invalidateNunjucksCache(oldpath);
      this._invalidateNunjucksCache(filepath);
      this.handlePageRename(filepath, oldpath);
    }

    if(!minimatch(filepath, dataMatcher) && minimatch(oldpath, dataMatcher)){
      console.log('handle data rename like delete');
      this.handleDataDelete(oldpath);
    } else if(minimatch(filepath, dataMatcher)) {
      console.log('handle data rename');
      this.handleDataRename(filepath, oldpath);
    }
  }, this));

  this.watcher.on('changed', _.bind(function(filepath){
    filepath = filepath.replace(process.cwd() + path.sep, '');
    if(minimatch(filepath, pageMatcher)){
      this.handlePageChange(filepath);
    }
    if(minimatch(filepath, dataMatcher)){
     this.handleDataChange(filepath);
    }
  }, this));

  this.watcher.on('deleted', _.bind(function(filepath){
    filepath = filepath.replace(process.cwd() + path.sep, '');
    if(minimatch(filepath, pageMatcher)){
      this.handlePageDelete(filepath);
    }
    if(minimatch(filepath, dataMatcher)){
     this.handleDataDelete(filepath);
    }
  }, this));
};

Press.prototype._dirtyPagesWithData = function(name){
  _.each(this.pages, function(page){
    if(page.data && _.contains(page.data, name)){
      page.dirty = true;
    }
  });
};

Press.prototype._rebuildPagesWithData = function(error, obj){
  this.data[obj.name] = obj.data;
  this._dirtyPagesWithData(obj.name);
  this.build();
};

Press.prototype._removeData = function(name){
  console.log('removing data keyed in', name);
  delete this.data[name];
};

Press.prototype.handleDataAdd = function(filepath){
  console.log('data add', filepath);
  this.parseData(filepath, this._rebuildPagesWithData);
};

Press.prototype.handleDataChange = function(filepath){
  console.log('data change', filepath);
  this.parseData(filepath, this._rebuildPagesWithData);
};

Press.prototype.handleDataDelete = function(filepath){
  console.log('data delete', filepath);
  var name = pressUtils.getFilename(filepath);
  this._removeData(name);
  this._dirtyPagesWithData(name);
  this.build();
};

Press.prototype.handleDataRename = function(newpath, oldpath){
  console.log('data rename', newpath, oldpath);
  var oldname = pressUtils.getFilename(oldpath);
  this._removeData(oldname);
  this._dirtyPagesWithData(oldname);
  this.parseData(newpath, this._rebuildPagesWithData);
};

Press.prototype._removeOldPage = function(filepath){
  filepath = filepath.replace(this.config.src + path.sep, '');
  var page = _.remove(this.pages, {src: filepath})[0];
  if(page && page.dest){
    var buildpath = path.join(this.config.dest, page.dest);
    fse.remove(buildpath);
  }
};

Press.prototype._loadNewPage = function(filepath){
  filepath = filepath.replace(path.join(this.config.root, this.config.src) + path.sep, '');
  console.log(filepath);
  if(path.basename(filepath)[0] !== '_'){
    this.loadPage(filepath, _.bind(function(error, page){
      this.pages.push(page);
      this.build();
    }, this));
  }
};

Press.prototype.handlePageAdd = function(filepath){
  console.log('page add', filepath);
  this._loadNewPage(filepath);
};

Press.prototype.handlePageChange = function(filepath){
  console.log('page change', filepath);
  this._removeOldPage(filepath);
  this._loadNewPage(filepath);
};

Press.prototype.handlePageDelete = function(filepath){
  console.log('page delete', filepath);
  this._removeOldPage(filepath);
};

Press.prototype.handlePageRename = function(newpath, oldpath){
  console.log('page rename', newpath, oldpath);
  this._removeOldPage(oldpath);
  this._loadNewPage(newpath);
};

Press.prototype.stopWatcher = function(){
  this.watcher.close();
};

/**
 * Press Helpers
 */

Press.prototype.metadata = function(pattern, data){
  this._extensions.push(metadataInjector(pattern, data));
};

Press.prototype.ignore = function(pattern){
  this._extensions.push(metadataInjector(pattern, {
    ignore: true
  }));
};

Press.prototype.layout = function(pattern, layout){
  this._extensions.push(metadataInjector(pattern, {
    layout: layout
  }));
};

Press.prototype.collection = function(name, pattern){
  this._extensions.push(collection(name, pattern));
};

Press.prototype.global = function(key, value){
  this.globals[key] = value;
};

Press.prototype.use = function(extension){
  if(extension.register){
    extension.register(this);
  }

  if (typeof extension === 'function'){
    this._extensions.push(extension);
  }
};

/**
 * Page Loader
 */

Press.prototype.loadPages = function (callback) {
  glob(path.join(this.config.src, pageGlob), this._loadPagesCallback(callback));
};

Press.prototype._loadPagesCallback = function (callback){
  return _.bind(function(error, filePaths){
    var files = _.filter(filePaths, function(filePath){
      return pressUtils.getFilename(filePath)[0] !== "_";
    });
    async.map(files, this.loadPage, function(error, pages){
      callback(error, pages);
    });
  }, this);
};

Press.prototype.loadPage = function(filepath, callback){
  fs.readFile(filepath, _.bind(function(error, buffer){
    var relativePath = filepath.replace(this.config.src + path.sep, '');
    var markdown = markdownExt.test(path.extname(relativePath));
    var metadata = _.merge({
      src: relativePath,
      template: filepath,
      dest: relativePath.replace(markdownExt, '.html'),
      markdown: markdown,
      dirty: true
    }, pressUtils.parseMetadata(buffer, filepath));
    callback(error, new Page(metadata, this));
  },this));
};

/**
 * Data Loader
 */

Press.prototype.loadData = function (callback) {
  glob(path.join(this.config.data, dataGlob), this._loadDataCallback(callback));
};

Press.prototype._loadDataCallback = function(callback){
  return _.bind(function(error, filePaths){
    async.map(filePaths, this.parseData, this._postProcessData(callback));
  }, this);
};

Press.prototype._postProcessData = function(callback) {
  return _.bind(function(error, dataFiles){
    var names = _.pluck(dataFiles, "name");
    var data = _.pluck(dataFiles, "data");
    callback(error, _.zipObject(names, data));
  }, this);
};

Press.prototype.parseData = function (filePath, callback) {
  var ext = path.extname(filePath);
  var parseCallback = Press.prototype.parseDataCallback(callback);

  if(ext === '.js') {
    this._parseModuleData(filePath, parseCallback);
  }

  if(ext === '.json') {
    this._parseJsonData(filePath, parseCallback);
  }

  if(ext === '.yaml' || ext === '.yml') {
    this._parseYamlData(filePath, parseCallback);
  }
};

Press.prototype.parseDataCallback = function(callback){
  return function (error, name, data){
    callback(error, {
      name: name,
      data: data
    });
  };
};

Press.prototype._parseYamlData = function(filepath, callback){
  var filename = pressUtils.getFilename(filepath);

  fs.readFile(filepath, function(error, content){
    if(error){
      // @TODO warn about load error
      callback(null, {});
      return null;
    }

    var data = {};

    try {
      console.log('loading yaml');
      data = yaml.safeLoad(content.toString(), {
        strict: true
      });
    } catch (e) {
      // @TODO warn about load error
      console.log("yaml error!" + e);
    }
    callback(null, filename, data);
  });
};

Press.prototype._parseModuleData = function(filepath, callback){
  console.log(filepath);
  var modulepath = path.join(this.config.root, filepath);
  var filename = pressUtils.getFilename(filepath);
  delete require.cache[modulepath];
  require(modulepath)(function(error, data){
    data = data || {};
    if(error){
      // @TODO warn about error
    }
    callback(error, filename, data);
  });
};

Press.prototype._parseJsonData = function(filepath, callback){
  var filename = pressUtils.getFilename(filepath);
  fs.readFile(filepath, function(error, content){
    if(error){
      // @TODO warn about load error
      callback(null, {});
      return null;
    }

    var data = {};

    try {
      data = JSON.parse(content.toString());
    } catch (e) {
      // @TODO warn about error
      console.log('JSON Error');
    }

    callback(error, filename, data);
  });
};

/**
 * Press Loading
 */

Press.prototype.load = function(callback){
  async.parallel({
    data: this.loadData,
    pages: this.loadPages
  }, this._loadCallback(callback));
};

Press.prototype._loadCallback = function (callback) {
  return _.bind(function(error, results){
    this.data = results.data;
    this.pages = results.pages;
    callback(error);
  }, this);
};

/**
 * Press Building
 */

Press.prototype.build = function(callback){
  console.log('build');
  async.series([
    this.runExtensions,
    this.buildPages
  ], callback);
};

Press.prototype.buildPages = function(callback){
  async.each(this.pages, _.bind(function(page, callback){
    page._build(callback);
  }, this), callback);
};

Press.prototype.runExtensions = function(callback) {
  var originalUse = this.use;
  var extensions = this._extensions.slice(0);
  var press = this;

  var checkForExtensions = _.bind(function(){
    return extensions.length;
  }, this);

  var runNextExtension = _.bind(function(cb){
    var extension = extensions.shift();
    extension(this, cb);
  },this);

  async.whilst(checkForExtensions, runNextExtension, callback);
};

/**
 * Exports
 */

function createPress(options, callback){
  var press = new Press(options);
  press.load(function(error){
    press.use(markdownHelpers);
    press.use(codeHighlighting);
    callback(undefined, press);
    press.use(prettyUrls);
    press.use(dataInjector);
    press.use(statsInjector);
    press.use(relativeUrls);
  });
}

module.exports = createPress;
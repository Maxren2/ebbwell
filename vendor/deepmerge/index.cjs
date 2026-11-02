'use strict';

// Based on deepmerge 4.3.1 (MIT); see LICENSE. Define own properties in both
// copy paths so an enumerable __proto__ can never invoke the inherited setter.
var isMergeableObject = function isMergeableObject(value) {
  return !!value && typeof value === 'object' && !isSpecial(value);
};

function isSpecial(value) {
  var stringValue = Object.prototype.toString.call(value);
  return stringValue === '[object RegExp]'
    || stringValue === '[object Date]'
    || value.$$typeof === REACT_ELEMENT_TYPE;
}

var REACT_ELEMENT_TYPE = typeof Symbol === 'function' && Symbol.for
  ? Symbol.for('react.element') : 0xeac7;

function emptyTarget(val) {
  return Array.isArray(val) ? [] : {};
}

function cloneUnlessOtherwiseSpecified(value, options) {
  return (options.clone !== false && options.isMergeableObject(value))
    ? deepmerge(emptyTarget(value), value, options)
    : value;
}

function defaultArrayMerge(target, source, options) {
  return target.concat(source).map(function(element) {
    return cloneUnlessOtherwiseSpecified(element, options);
  });
}

function getMergeFunction(key, options) {
  if (!options.customMerge) return deepmerge;
  var customMerge = options.customMerge(key);
  return typeof customMerge === 'function' ? customMerge : deepmerge;
}

function getKeys(target) {
  return Object.keys(target).concat(Object.getOwnPropertySymbols(target).filter(function(symbol) {
    return Object.propertyIsEnumerable.call(target, symbol);
  }));
}

function propertyIsOnObject(object, property) {
  try {
    return property in object;
  } catch (_) {
    return false;
  }
}

function propertyIsUnsafe(target, key) {
  return propertyIsOnObject(target, key)
    && !(Object.hasOwnProperty.call(target, key)
      && Object.propertyIsEnumerable.call(target, key));
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value: value, enumerable: true, writable: true, configurable: true
  });
}

function mergeObject(target, source, options) {
  var destination = {};
  if (options.isMergeableObject(target)) {
    getKeys(target).forEach(function(key) {
      setOwn(destination, key, cloneUnlessOtherwiseSpecified(target[key], options));
    });
  }
  getKeys(source).forEach(function(key) {
    if (propertyIsUnsafe(target, key)) return;
    if (propertyIsOnObject(target, key) && options.isMergeableObject(source[key])) {
      setOwn(destination, key, getMergeFunction(key, options)(target[key], source[key], options));
    } else {
      setOwn(destination, key, cloneUnlessOtherwiseSpecified(source[key], options));
    }
  });
  return destination;
}

function deepmerge(target, source, options) {
  options = options || {};
  options.arrayMerge = options.arrayMerge || defaultArrayMerge;
  options.isMergeableObject = options.isMergeableObject || isMergeableObject;
  options.cloneUnlessOtherwiseSpecified = cloneUnlessOtherwiseSpecified;
  var sourceIsArray = Array.isArray(source);
  var targetIsArray = Array.isArray(target);
  if (sourceIsArray !== targetIsArray) {
    return cloneUnlessOtherwiseSpecified(source, options);
  } else if (sourceIsArray) {
    return options.arrayMerge(target, source, options);
  } else {
    return mergeObject(target, source, options);
  }
}

deepmerge.all = function deepmergeAll(array, options) {
  if (!Array.isArray(array)) throw new Error('first argument should be an array');
  return array.reduce(function(prev, next) {
    return deepmerge(prev, next, options);
  }, {});
};

module.exports = deepmerge;

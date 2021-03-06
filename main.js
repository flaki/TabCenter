/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Vertical Tabs.
 *
 * The Initial Developer of the Original Code is
 * Philipp von Weitershausen.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/* global require, exports:false */
'use strict';


const {prefixURI} = require('@loader/options');
const prefs = require('sdk/simple-prefs');
const {setInterval} = require('sdk/timers');
const {mount, unmount} = require('sdk/uri/resource');
const {viewFor} = require('sdk/view/core');
const {browserWindows} = require('sdk/windows');
const {isBrowser, isDocumentLoaded} = require('sdk/window/utils');
const {Hotkey} = require('sdk/hotkeys');

const {Cc, Ci, Cu} = require('chrome');
const windowWatcher = Cc['@mozilla.org/embedcomp/window-watcher;1'].
                       getService(Ci.nsIWindowWatcher);
const ss = Cc['@mozilla.org/browser/sessionstore;1'].getService(Ci.nsISessionStore);

const strings = require('./get-locale-strings').getLocaleStrings();
const utils = require('./utils');
const {addVerticalTabs} = require('./verticaltabs');

let self = require('sdk/self');
const RESOURCE_HOST = 'tabcenter';

let hotkey;
let VerticalTabsWindowId = 1;

function b64toBlob(win, b64Data, contentType, sliceSize) {
  contentType = contentType || '';
  sliceSize = sliceSize || 512;

  let byteCharacters = win.atob(b64Data);
  let byteArrays = [];

  for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
    let slice = byteCharacters.slice(offset, offset + sliceSize);

    let byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }

    let byteArray = new Uint8Array(byteNumbers);

    byteArrays.push(byteArray);
  }

  return new win.Blob(byteArrays, {type: contentType});
}

function setPersistantAttrs(win){
  let mainWindow = win.document.getElementById('main-window');
  mainWindow.setAttribute('persist', mainWindow.getAttribute('persist') + ' tabspinned tabspinnedwidth toggledon');
  try {
    mainWindow.setAttribute('toggledon', ss.getWindowValue(win, 'TCtoggledon'));
    mainWindow.setAttribute('tabspinnedwidth', ss.getWindowValue(win, 'TCtabspinnedwidth'));
    mainWindow.setAttribute('tabspinned', ss.getWindowValue(win, 'TCtabspinned'));
  } catch (e) {
    if (e.name !== 'NS_ERROR_ILLEGAL_VALUE') {
      throw e;
    }
    // on fresh windows getWindowValue throws an exception. Ignore this.
  }
}

function initWindow(window) {
  // get the XUL window that corresponds to this high-level window
  let win = viewFor(window);

  win.tabCenterEventListener = {};

  win.addEventListener('TabOpen', win.tabCenterEventListener, false);
  win.addEventListener('TabClose', win.tabCenterEventListener, false);
  win.addEventListener('TabPinned', win.tabCenterEventListener, false);
  win.addEventListener('TabUnpinned', win.tabCenterEventListener, false);

  win.tabCenterEventListener.handleEvent = function (aEvent) {
    switch (aEvent.type) {
    case 'TabOpen':
      utils.sendPing('tabs_created', win);
      return;
    case 'TabClose':
      utils.sendPing('tabs_destroyed', win);
      return;
    case 'TabPinned':
      utils.sendPing('tabs_pinned', win);
      return;
    case 'TabUnpinned':
      utils.sendPing('tabs_unpinned', win);
      return;
    }
  };

  win.VerticalTabsWindowId = VerticalTabsWindowId;
  VerticalTabsWindowId++;

  let data = b64toBlob(win, self.data.load('newtab.b64'), 'image/png');

  // check for browser windows with visible toolbars
  if (!win.toolbar.visible || !isBrowser(win)) {
    return;
  }

  // if the dcoument is loaded
  if (isDocumentLoaded(win)) {
    setPersistantAttrs(win);
    addVerticalTabs(win, data);
  } else {
    // Listen for load event before checking the window type
    win.addEventListener('load', () => {
      setPersistantAttrs(win);
      addVerticalTabs(win, data);
    }, {once: true});
  }
}

function largeTabsChange() {
  for (let window of browserWindows) {
    let win = viewFor(window);
    if (win.VerticalTabs) {
      win.VerticalTabs.resizeTabs();
    }
  }
}

exports.main = function (options, callbacks) {
  // Listen for preference changes
  prefs.on('largetabs', largeTabsChange);

  // Register the resource:// alias.
  mount(RESOURCE_HOST, prefixURI);

  // Override default preferences
  utils.setDefaultPrefs();

  // Startup VerticalTabs object for each window.
  for (let window of browserWindows) {
    //cause no disruption to users when changing the way we handle
    //the tabsontop pref between v1.26 and v1.27
    let win = viewFor(window);
    let mainWindow = win.document.getElementById('main-window');
    let tabbrowser = win.document.getElementById('tabbrowser-tabs');
    if (mainWindow.getAttribute('doNotReverse') !== 'true' && options.loadReason === 'upgrade' && prefs.prefs.opentabstop === true) {
      let reversedTabs = Array.prototype.slice.call(tabbrowser.children).reverse();
      for (let tab of reversedTabs) {
        tabbrowser.appendChild(tab, tabbrowser.firstChild);
      }
    }
    initWindow(window);
  }

  windowWatcher.registerNotification({
    observe: function observe(subject, topic, data) {
      try {
        let window = subject.QueryInterface(Ci.nsIDOMWindow);
        if (topic === 'domwindowopened') {
          window.addEventListener('load', () => {
            initWindow(window);
          }, {once: true});
        }
      }
      catch(e) {
        console.exception(e); // eslint-disable-line no-console
      }
    }
  });

  hotkey = Hotkey({
    combo: 'accel-shift-l',
    onPress: function () {
      let window = viewFor(browserWindows.activeWindow);
      let input = window.document.getElementById('find-input');
      if (input) {
        let mainWindow = window.document.getElementById('main-window');
        let sidebar = window.document.getElementById('verticaltabs-box');
        if (mainWindow.getAttribute('tabspinned') === 'true' &&
          input.style.visibility === 'collapse') {
          return;
        }
        if (sidebar.getAttribute('search_expanded') === 'true') {
          sidebar.removeAttribute('search_expanded');
          input.blur();
          if (mainWindow.getAttribute('tabspinned') !== 'true') {
            sidebar.removeAttribute('expanded');
            window.VerticalTabs.clearFind();
          }
        } else {
          sidebar.setAttribute('search_expanded', 'true');
          sidebar.setAttribute('expanded', 'true');
          window.setTimeout(() => {
            input.focus();
          }, 150);
          if (mainWindow.getAttribute('tabspinned') !== 'true') {
            window.VerticalTabs.recordExpansion();
            window.VerticalTabs.adjustCrop();
          }
        }
      }
    }
  });
};

exports.onUnload = function (reason) {
  // If the app is shutting down, skip the rest
  if (reason === 'shutdown') {
    for (let window of browserWindows) {
      let win = viewFor(window);
      let mainWindow = win.document.getElementById('main-window');
      ss.setWindowValue(win, 'TCtabspinnedwidth', mainWindow.getAttribute('tabspinnedwidth'));
      ss.setWindowValue(win, 'TCtabspinned', mainWindow.getAttribute('tabspinned'));
      ss.setWindowValue(win, 'TCtoggledon', mainWindow.getAttribute('toggledon'));
    }
    return;
  }

  hotkey.destroy();

  // Shutdown the VerticalTabs object for each window.
  for (let window of browserWindows) {
    let win = viewFor(window);
    if (win.VerticalTabs) {
      win.VerticalTabs.unload();
      let mainWindow = win.document.getElementById('main-window');
      mainWindow.setAttribute('doNotReverse', 'true');
      mainWindow.removeAttribute('tabspinned');
      mainWindow.removeAttribute('tabspinnedwidth');
      mainWindow.removeAttribute('toggledon');
      mainWindow.setAttribute('persist',
        mainWindow.getAttribute('persist').replace(' tabspinned', '').replace(' tabspinnedwidth', '').replace(' toggledon', ''));

      win.removeEventListener('TabOpen', win.tabCenterEventListener, false);
      win.removeEventListener('TabClose', win.tabCenterEventListener, false);
      win.removeEventListener('TabPinned', win.tabCenterEventListener, false);
      win.removeEventListener('TabUnpinned', win.tabCenterEventListener, false);
      delete win.VerticalTabs;
    }
  }

  // Restore default preferences
  utils.removeDefaultPrefs();

  // Unregister the resource:// alias.
  unmount(RESOURCE_HOST, null);
};

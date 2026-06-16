/**
 * ============================================================
 * 【美味しい1杯】飲み友達探し — バックエンド (Google Apps Script)
 * ============================================================
 *
 * スプレッドシートの列構成（1行目がヘッダー）：
 *   A: rowId        （自動生成UUID）
 *   B: nickname     （ニックネーム）
 *   C: contact      （連絡先/SNS）
 *   D: area         （よく行くエリア）
 *   E: drink        （お酒の好み）
 *   F: comment      （一言コメント）
 *   G: passwordHash （ユーザーパスワードのSHA-256ハッシュ）
 *   H: date         （登録日時）
 *
 * ============================================================
 */

// ▼ スプレッドシートIDを設定してください（URLの /d/〇〇〇/ の部分）
var SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';
var SHEET_NAME     = 'members';

// ▼ 管理者パスワードをここに設定してください（絶対に公開しないこと）
var ADMIN_PASSWORD = 'YOUR_ADMIN_PASSWORD_HERE';

// ============================================================
// GET リクエスト処理
// ============================================================
function doGet(e) {
  var action = e.parameter.action;

  try {
    if (action === 'list') {
      return handleList();
    }
    if (action === 'verify') {
      return handleVerify(e.parameter.rowId, e.parameter.password);
    }
    if (action === 'adminList') {
      return handleAdminList(e.parameter.adminPassword);
    }
    return jsonResponse({ status: 'error', message: '不正なアクションです' });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}

// ============================================================
// POST リクエスト処理
// ============================================================
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ status: 'error', message: 'リクエストの解析に失敗しました' });
  }

  var action = body.action;

  try {
    if (action === 'add')         return handleAdd(body);
    if (action === 'update')      return handleUpdate(body);
    if (action === 'delete')      return handleDelete(body);
    if (action === 'adminUpdate') return handleAdminUpdate(body);
    if (action === 'adminDelete') return handleAdminDelete(body);
    return jsonResponse({ status: 'error', message: '不正なアクションです' });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}

// ============================================================
// 一覧取得（一般用：パスワードハッシュを除外）
// ============================================================
function handleList() {
  var sheet = getSheet();
  var data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return jsonResponse({ status: 'ok', members: [] });

  var members = [];
  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    if (!row[0]) continue;
    members.push(rowToMember(row, false));
  }
  return jsonResponse({ status: 'ok', members: members });
}

// ============================================================
// 管理者：一覧取得（全データ。パスワードハッシュは除外）
// ============================================================
function handleAdminList(adminPassword) {
  if (!verifyAdminPassword(adminPassword)) {
    return jsonResponse({ status: 'error', message: '管理者パスワードが違います' });
  }

  var sheet = getSheet();
  var data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return jsonResponse({ status: 'ok', members: [] });

  var members = [];
  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    if (!row[0]) continue;
    members.push(rowToMember(row, false)); // ハッシュは返さない
  }
  return jsonResponse({ status: 'ok', members: members });
}

// ============================================================
// パスワード検証（ユーザー修正前確認用）
// ============================================================
function handleVerify(rowId, password) {
  if (!rowId || !password) {
    return jsonResponse({ status: 'error', message: 'パラメーターが不足しています' });
  }
  var result = findRowByIdAndVerify(rowId, password);
  if (!result.ok) return jsonResponse({ status: 'error', message: result.message });

  return jsonResponse({ status: 'ok', member: rowToMember(result.rowData, false) });
}

// ============================================================
// 新規登録
// ============================================================
function handleAdd(body) {
  var nickname = sanitize(body.nickname);
  var contact  = sanitize(body.contact);
  var area     = sanitize(body.area);
  var drink    = sanitize(body.drink);
  var comment  = sanitize(body.comment);
  var password = body.password;

  if (!nickname || !area || !drink || !comment || !password) {
    return jsonResponse({ status: 'error', message: '必須項目が不足しています' });
  }
  if (nickname.length > 20)  return jsonResponse({ status: 'error', message: 'ニックネームが長すぎます' });
  if (comment.length  > 100) return jsonResponse({ status: 'error', message: 'コメントが長すぎます' });
  if (password.length < 4 || password.length > 20) {
    return jsonResponse({ status: 'error', message: 'パスワードは4〜20文字で設定してください' });
  }

  var sheet = getSheet();
  var rowId = Utilities.getUuid();
  sheet.appendRow([rowId, nickname, contact, area, drink, comment, hashPassword(password), new Date()]);

  return jsonResponse({ status: 'ok', message: '登録しました', rowId: rowId });
}

// ============================================================
// 更新（ユーザー本人：ユーザーパスワードで検証）
// ============================================================
function handleUpdate(body) {
  var rowId    = body.rowId;
  var password = body.password;
  if (!rowId || !password) {
    return jsonResponse({ status: 'error', message: 'パラメーターが不足しています' });
  }

  var result = findRowByIdAndVerify(rowId, password);
  if (!result.ok) return jsonResponse({ status: 'error', message: result.message });

  return applyUpdate(result.rowIndex, body);
}

// ============================================================
// 削除（ユーザー本人：ユーザーパスワードで検証）
// ============================================================
function handleDelete(body) {
  var rowId    = body.rowId;
  var password = body.password;
  if (!rowId || !password) {
    return jsonResponse({ status: 'error', message: 'パラメーターが不足しています' });
  }

  var result = findRowByIdAndVerify(rowId, password);
  if (!result.ok) return jsonResponse({ status: 'error', message: result.message });

  getSheet().deleteRow(result.rowIndex);
  return jsonResponse({ status: 'ok', message: '削除しました' });
}

// ============================================================
// 管理者：更新（管理者パスワードで検証）
// ============================================================
function handleAdminUpdate(body) {
  if (!verifyAdminPassword(body.adminPassword)) {
    return jsonResponse({ status: 'error', message: '管理者パスワードが違います' });
  }

  var result = findRowById(body.rowId);
  if (!result.ok) return jsonResponse({ status: 'error', message: result.message });

  return applyUpdate(result.rowIndex, body);
}

// ============================================================
// 管理者：削除（管理者パスワードで検証）
// ============================================================
function handleAdminDelete(body) {
  if (!verifyAdminPassword(body.adminPassword)) {
    return jsonResponse({ status: 'error', message: '管理者パスワードが違います' });
  }

  var result = findRowById(body.rowId);
  if (!result.ok) return jsonResponse({ status: 'error', message: result.message });

  getSheet().deleteRow(result.rowIndex);
  return jsonResponse({ status: 'ok', message: '削除しました' });
}

// ============================================================
// 共通：行データを更新する
// ============================================================
function applyUpdate(rowIndex, body) {
  var nickname = sanitize(body.nickname);
  var contact  = sanitize(body.contact);
  var area     = sanitize(body.area);
  var drink    = sanitize(body.drink);
  var comment  = sanitize(body.comment);

  if (!nickname || !area || !drink || !comment) {
    return jsonResponse({ status: 'error', message: '必須項目が不足しています' });
  }
  if (nickname.length > 20)  return jsonResponse({ status: 'error', message: 'ニックネームが長すぎます' });
  if (comment.length  > 100) return jsonResponse({ status: 'error', message: 'コメントが長すぎます' });

  var sheet = getSheet();
  sheet.getRange(rowIndex, 2).setValue(nickname);
  sheet.getRange(rowIndex, 3).setValue(contact);
  sheet.getRange(rowIndex, 4).setValue(area);
  sheet.getRange(rowIndex, 5).setValue(drink);
  sheet.getRange(rowIndex, 6).setValue(comment);

  return jsonResponse({ status: 'ok', message: '更新しました' });
}

// ============================================================
// ユーティリティ
// ============================================================

/** 管理者パスワード検証 */
function verifyAdminPassword(adminPassword) {
  if (!adminPassword) return false;
  return hashPassword(adminPassword) === hashPassword(ADMIN_PASSWORD);
}

/** rowId でシートを検索し、ユーザーパスワードを検証して行データを返す */
function findRowByIdAndVerify(rowId, password) {
  var sheet  = getSheet();
  var data   = sheet.getDataRange().getValues();
  var pwHash = hashPassword(password);

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(rowId)) {
      if (String(data[i][6]) !== pwHash) {
        return { ok: false, message: 'パスワードが違います' };
      }
      return { ok: true, rowIndex: i + 1, rowData: data[i] };
    }
  }
  return { ok: false, message: '投稿が見つかりません' };
}

/** rowId でシートを検索して行データを返す（パスワード検証なし・管理者用） */
function findRowById(rowId) {
  var sheet = getSheet();
  var data  = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(rowId)) {
      return { ok: true, rowIndex: i + 1, rowData: data[i] };
    }
  }
  return { ok: false, message: '投稿が見つかりません' };
}

/** 行データをオブジェクトへ変換（includeHash=falseでハッシュを除外） */
function rowToMember(row, includeHash) {
  var obj = {
    rowId:    String(row[0]),
    nickname: String(row[1]),
    contact:  String(row[2]),
    area:     String(row[3]),
    drink:    String(row[4]),
    comment:  String(row[5]),
    date:     row[7] ? Utilities.formatDate(new Date(row[7]), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : ''
  };
  if (includeHash) obj.passwordHash = String(row[6]);
  return obj;
}

/** SHA-256 ハッシュ */
function hashPassword(password) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, password, Utilities.Charset.UTF_8
  );
  return raw.map(function(b) {
    var hex = (b < 0 ? b + 256 : b).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

/** シートオブジェクトを返す（なければ作成） */
function getSheet() {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['rowId','nickname','contact','area','drink','comment','passwordHash','date']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** CORS対応JSONレスポンス */
function jsonResponse(obj) {
  var output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/** 簡易サニタイズ */
function sanitize(str) {
  if (!str) return '';
  return String(str).trim()
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

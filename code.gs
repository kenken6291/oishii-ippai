/**
 * ============================================================
 * 【美味しい1杯】飲み友達探し — バックエンド (Google Apps Script)
 * 会員認証システム版 + 写真/お店URL/レビュー機能
 * ============================================================
 *
 * スプレッドシート構成（各シート1行目がヘッダー）：
 *
 * ■ users シート
 *   A: userId          （自動生成UUID）
 *   B: email            （ログイン用メールアドレス）
 *   C: passwordHash     （SHA-256+salt+pepper、ストレッチ済み）
 *   D: salt              （ユーザーごとのランダムsalt）
 *   E: nickname          （表示用ニックネーム）
 *   F: isTempPassword    （true/false：仮パスワードのままか）
 *   G: agreedTermsAt     （注意事項・免責事項に同意した日時）
 *   H: status            （active / deleted）
 *   I: createdAt         （登録日時）
 *
 * ■ members シート（投稿）
 *   A: rowId
 *   B: userId           （投稿者。usersシートのuserIdと紐付け）
 *   C: nickname
 *   D: contact
 *   E: area
 *   F: drink
 *   G: comment          （投稿者の一言コメント）
 *   H: storeUrl         （お店のURL・任意）
 *   I: photoUrl         （Googleドライブ上の写真URL・任意）
 *   J: date
 *
 * ■ favorites シート
 *   A: userId
 *   B: rowId            （お気に入りした投稿のrowId）
 *   C: createdAt
 *
 * ■ reviews シート（他の会員によるお店レビュー：コメント＋5段階評価）
 *   A: reviewId
 *   B: rowId            （対象の投稿rowId）
 *   C: userId            （レビューした会員）
 *   D: nickname
 *   E: rating            （1〜5の整数）
 *   F: comment
 *   G: createdAt
 *   H: updatedAt
 *   ※ 1会員につき1投稿に対して1レビューまで（再投稿は上書き更新）
 *
 * ■ rankings シート（会員ごとの「おすすめベスト100」）
 *   A: userId
 *   B: rowId            （ランクインした投稿のrowId）
 *   C: rank              （1〜100の順位。1位が最上位）
 *   D: updatedAt
 *   ※ 得点は 101-rank（1位=100点、100位=1点）として集計時に計算する
 *   ※ 1会員のベスト100は毎回全件洗い替え（保存時に既存分を削除して作り直す）
 *
 * ============================================================
 */

// ============================================================
// 秘密情報はスクリプトプロパティから読み込む（コードに直書きしない）
// 設定方法: GASエディタ →「プロジェクトの設定」→「スクリプトプロパティ」で以下3つを追加
//   SPREADSHEET_ID   : スプレッドシートのID
//   ADMIN_PASSWORD   : 管理者ページ用パスワード
//   PEPPER           : パスワードハッシュ用の秘密文字列
// こうすることで、clasp/GitHubでコードを管理してもパスワード等が
// リポジトリに含まれず、GASプロジェクト内にのみ安全に保存される。
// ============================================================
var SCRIPT_PROPS = PropertiesService.getScriptProperties();

var SPREADSHEET_ID = requireProp('SPREADSHEET_ID');
var ADMIN_PASSWORD  = requireProp('ADMIN_PASSWORD');
var PEPPER           = requireProp('PEPPER');

var SHEET_USERS      = 'users';
var SHEET_MEMBERS    = 'members';
var SHEET_FAVORITES  = 'favorites';
var SHEET_REVIEWS    = 'reviews';
var SHEET_RANKINGS   = 'rankings';

// ▼ パスワードハッシュ用の秘密文字列は上の requireProp('PEPPER') で読み込み済み

// ▼ ハッシュのストレッチ回数（GAS実行時間の制約により2000程度を推奨）
var PBKDF_ITERATIONS = 2000;

// ▼ セッションの有効期限（秒）。CacheServiceの上限は6時間(21600秒)
var SESSION_TTL_SEC = 21600;

// ▼ 写真保存先のGoogleドライブフォルダID（スクリプトプロパティ未設定の場合は自動でフォルダを作成）
var PHOTO_FOLDER_ID = SCRIPT_PROPS.getProperty('PHOTO_FOLDER_ID') || '';

// ▼ 写真1枚あたりの最大サイズ（バイト）。フロント側で縮小済みの前提だが念のための上限
var MAX_PHOTO_BYTES = 4 * 1024 * 1024; // 4MB

// ▼ ベスト100ランキングの最大登録件数
var MAX_RANKING_ITEMS = 100;

// スクリプトプロパティが未設定の場合にエラーで気づけるようにするヘルパー
function requireProp(key) {
  var value = SCRIPT_PROPS.getProperty(key);
  if (!value) {
    throw new Error('スクリプトプロパティ「' + key + '」が設定されていません。' +
      'GASエディタの「プロジェクトの設定」→「スクリプトプロパティ」で設定してください。');
  }
  return value;
}

// ============================================================
// GET リクエスト処理
// ============================================================
function doGet(e) {
  var action = e.parameter.action;

  try {
    if (action === 'list')          return handleList();
    if (action === 'adminList')     return handleAdminList(e.parameter.adminPassword);
    if (action === 'myFavorites')   return handleMyFavorites(e.parameter.token);
    if (action === 'me')            return handleMe(e.parameter.token);
    if (action === 'reviews')       return handleListReviews(e.parameter.rowId);
    if (action === 'myRanking')     return handleMyRanking(e.parameter.token);
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
    // --- 会員認証 ---
    if (action === 'register')             return handleRegister(body);
    if (action === 'login')                return handleLogin(body);
    if (action === 'logout')               return handleLogout(body);
    if (action === 'changePassword')       return handleChangePassword(body);
    if (action === 'updateNickname')       return handleUpdateNickname(body);
    if (action === 'requestPasswordReset') return handleRequestPasswordReset(body);
    if (action === 'deleteAccount')        return handleDeleteAccount(body);

    // --- 投稿（ログイン必須） ---
    if (action === 'add')     return handleAdd(body);
    if (action === 'update')  return handleUpdate(body);
    if (action === 'delete')  return handleDelete(body);

    // --- お気に入り ---
    if (action === 'addFavorite')    return handleAddFavorite(body);
    if (action === 'removeFavorite') return handleRemoveFavorite(body);

    // --- レビュー（コメント＋5段階評価） ---
    if (action === 'submitReview') return handleSubmitReview(body);
    if (action === 'deleteReview') return handleDeleteReview(body);

    // --- おすすめベスト100 ---
    if (action === 'saveMyRanking') return handleSaveMyRanking(body);

    // --- 管理者 ---
    if (action === 'adminUpdate') return handleAdminUpdate(body);
    if (action === 'adminDelete') return handleAdminDelete(body);

    return jsonResponse({ status: 'error', message: '不正なアクションです' });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}

// ============================================================
// 会員登録
// ============================================================
function handleRegister(body) {
  var email    = normalizeEmail(body.email);
  var nickname = sanitize(body.nickname);
  var agreed   = body.agreedTerms === true;

  if (!email || !isValidEmail(email)) return jsonResponse({ status: 'error', message: 'メールアドレスが正しくありません' });
  if (!nickname) return jsonResponse({ status: 'error', message: 'ニックネームを入力してください' });
  if (nickname.length > 20) return jsonResponse({ status: 'error', message: 'ニックネームが長すぎます' });
  if (!agreed) return jsonResponse({ status: 'error', message: '注意事項・免責事項への同意が必要です' });

  if (findUserByEmail(email)) {
    return jsonResponse({ status: 'error', message: 'このメールアドレスは既に登録されています' });
  }

  var tempPassword = generateTempPassword();
  var salt   = Utilities.getUuid();
  var hash   = hashPassword(tempPassword, salt);
  var userId = Utilities.getUuid();
  var now    = new Date();

  getUsersSheet().appendRow([userId, email, hash, salt, nickname, true, now, 'active', now]);

  try {
    MailApp.sendEmail(email, '【美味しい1杯】仮パスワードのご案内',
      nickname + ' 様\n\n【美味しい1杯】への会員登録ありがとうございます。\n' +
      '以下の仮パスワードでログインし、初回ログイン時に必ず新しいパスワードへ変更してください。\n\n' +
      '仮パスワード： ' + tempPassword + '\n\n' +
      '※このメールに心当たりがない場合は破棄してください。');
  } catch (mailErr) {
    Logger.log('sendEmail failed: ' + mailErr.message);
  }

  return jsonResponse({ status: 'ok', message: '登録が完了しました。仮パスワードをメールで送信しました。' });
}

// ============================================================
// ログイン
// ============================================================
function handleLogin(body) {
  var email    = normalizeEmail(body.email);
  var password = body.password || '';

  var user = findUserByEmail(email);
  if (!user || user.status !== 'active') {
    return jsonResponse({ status: 'error', message: 'メールアドレスまたはパスワードが違います' });
  }

  var hash = hashPassword(password, user.salt);
  if (hash !== user.passwordHash) {
    return jsonResponse({ status: 'error', message: 'メールアドレスまたはパスワードが違います' });
  }

  var token = createSession(user.userId);
  return jsonResponse({
    status: 'ok',
    token: token,
    userId: user.userId,
    nickname: user.nickname,
    email: user.email,
    mustChangePassword: (user.isTempPassword === true || user.isTempPassword === 'TRUE')
  });
}

function handleLogout(body) {
  if (body.token) CacheService.getScriptCache().remove('session_' + body.token);
  return jsonResponse({ status: 'ok' });
}

function handleMe(token) {
  var session = getSession(token);
  if (!session) return jsonResponse({ status: 'error', message: 'not_logged_in' });
  var user = findUserById(session.userId);
  if (!user) return jsonResponse({ status: 'error', message: 'not_logged_in' });
  return jsonResponse({ status: 'ok', userId: user.userId, nickname: user.nickname, email: user.email });
}

// ============================================================
// パスワード変更（初回強制変更／マイページからの任意変更）
// ============================================================
function handleChangePassword(body) {
  var session = getSession(body.token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var user = findUserById(session.userId);
  if (!user) return jsonResponse({ status: 'error', message: 'ユーザーが見つかりません' });

  var newPassword = body.newPassword || '';
  if (newPassword.length < 4 || newPassword.length > 20) {
    return jsonResponse({ status: 'error', message: 'パスワードは4〜20文字で設定してください' });
  }

  var isTemp = (user.isTempPassword === true || user.isTempPassword === 'TRUE');
  if (!isTemp) {
    var current = body.currentPassword || '';
    if (hashPassword(current, user.salt) !== user.passwordHash) {
      return jsonResponse({ status: 'error', message: '現在のパスワードが違います' });
    }
  }

  var newSalt = Utilities.getUuid();
  var newHash = hashPassword(newPassword, newSalt);
  updateUserRow(user.rowIndex, { passwordHash: newHash, salt: newSalt, isTempPassword: false });

  return jsonResponse({ status: 'ok', message: 'パスワードを変更しました' });
}

// ============================================================
// ニックネーム変更
// ============================================================
function handleUpdateNickname(body) {
  var session = getSession(body.token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var nickname = sanitize(body.nickname);
  if (!nickname) return jsonResponse({ status: 'error', message: 'ニックネームを入力してください' });
  if (nickname.length > 20) return jsonResponse({ status: 'error', message: 'ニックネームが長すぎます' });

  var user = findUserById(session.userId);
  updateUserRow(user.rowIndex, { nickname: nickname });

  syncNicknameToMembers(session.userId, nickname);
  syncNicknameToReviews(session.userId, nickname);

  return jsonResponse({ status: 'ok', nickname: nickname });
}

// ============================================================
// パスワードを忘れた場合（仮パスワード再発行）
// ============================================================
function handleRequestPasswordReset(body) {
  var email = normalizeEmail(body.email);
  var user = findUserByEmail(email);

  if (user && user.status === 'active') {
    var tempPassword = generateTempPassword();
    var newSalt = Utilities.getUuid();
    var newHash = hashPassword(tempPassword, newSalt);
    updateUserRow(user.rowIndex, { passwordHash: newHash, salt: newSalt, isTempPassword: true });

    try {
      MailApp.sendEmail(email, '【美味しい1杯】仮パスワード再発行のご案内',
        user.nickname + ' 様\n\n仮パスワードを再発行しました。\n\n' +
        '仮パスワード： ' + tempPassword + '\n\n' +
        'ログイン後、必ず新しいパスワードに変更してください。\n\n' +
        '※心当たりがない場合はこのメールを破棄してください。');
    } catch (mailErr) {
      Logger.log('sendEmail failed: ' + mailErr.message);
    }
  }

  return jsonResponse({ status: 'ok', message: '登録済みのメールアドレスであれば、仮パスワードを送信しました。' });
}

// ============================================================
// 退会（アカウント削除）
// ============================================================
function handleDeleteAccount(body) {
  var session = getSession(body.token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var user = findUserById(session.userId);
  if (!user) return jsonResponse({ status: 'error', message: 'ユーザーが見つかりません' });

  var password = body.password || '';
  if (hashPassword(password, user.salt) !== user.passwordHash) {
    return jsonResponse({ status: 'error', message: 'パスワードが違います' });
  }

  updateUserRow(user.rowIndex, {
    status: 'deleted',
    email: 'deleted_' + user.userId + '@deleted.local',
    passwordHash: '',
    salt: ''
  });

  deletePhotosForUserPosts(session.userId);
  deleteMembersByUser(session.userId);
  deleteFavoritesByUser(session.userId);
  deleteReviewsByUser(session.userId);
  deleteRankingsByUser(session.userId);

  CacheService.getScriptCache().remove('session_' + body.token);
  return jsonResponse({ status: 'ok', message: '退会処理が完了しました。ご利用ありがとうございました。' });
}

// ============================================================
// 一覧取得（一般公開。ログイン不要）
// ============================================================
function handleList() {
  var sheet = getMembersSheet();
  var data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return jsonResponse({ status: 'ok', members: [] });

  var ratingMap  = buildRatingMap();
  var hensachiMap = buildHensachiMap();

  var members = [];
  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    if (!row[0]) continue;
    members.push(rowToMember(row, ratingMap, hensachiMap));
  }
  return jsonResponse({ status: 'ok', members: members });
}

// ============================================================
// 新規投稿（ログイン必須）
// ============================================================
function handleAdd(body) {
  var session = getSession(body.token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var user = findUserById(session.userId);
  if (!user) return jsonResponse({ status: 'error', message: 'ユーザーが見つかりません' });

  var contact  = sanitize(body.contact);
  var area     = sanitize(body.area);
  var drink    = sanitize(body.drink);
  var comment  = sanitize(body.comment);
  var storeUrl = sanitizeUrl(body.storeUrl);

  if (!area)    return jsonResponse({ status: 'error', message: 'よく行くエリアを選択してください' });
  if (!drink)   return jsonResponse({ status: 'error', message: 'お酒の好みを選択してください' });
  if (!comment) return jsonResponse({ status: 'error', message: '一言コメントを入力してください' });
  if (comment.length > 100) return jsonResponse({ status: 'error', message: 'コメントが長すぎます' });
  if (body.storeUrl && !storeUrl) return jsonResponse({ status: 'error', message: 'お店のURLの形式が正しくありません' });

  var photoUrl = '';
  if (body.photoBase64) {
    var photoResult = savePhotoToDrive(body.photoBase64, body.photoMimeType, session.userId);
    if (!photoResult.ok) return jsonResponse({ status: 'error', message: photoResult.message });
    photoUrl = photoResult.url;
  }

  var sheet = getMembersSheet();
  var rowId = Utilities.getUuid();
  sheet.appendRow([rowId, session.userId, user.nickname, contact, area, drink, comment, storeUrl, photoUrl, new Date()]);

  return jsonResponse({ status: 'ok', message: '登録しました', rowId: rowId, photoUrl: photoUrl });
}

// ============================================================
// 投稿の修正（ログイン必須・自分の投稿のみ）
// ============================================================
function handleUpdate(body) {
  var session = getSession(body.token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var result = findMemberRowById(body.rowId);
  if (!result.ok) return jsonResponse({ status: 'error', message: result.message });
  if (result.rowData[1] !== session.userId) {
    return jsonResponse({ status: 'error', message: '自分の投稿のみ編集できます' });
  }

  var contact  = sanitize(body.contact);
  var area     = sanitize(body.area);
  var drink    = sanitize(body.drink);
  var comment  = sanitize(body.comment);
  var storeUrl = sanitizeUrl(body.storeUrl);

  if (!area)    return jsonResponse({ status: 'error', message: 'エリアを選択してください' });
  if (!drink)   return jsonResponse({ status: 'error', message: 'お酒の好みを選択してください' });
  if (!comment) return jsonResponse({ status: 'error', message: 'コメントを入力してください' });
  if (comment.length > 100) return jsonResponse({ status: 'error', message: 'コメントが長すぎます' });
  if (body.storeUrl && !storeUrl) return jsonResponse({ status: 'error', message: 'お店のURLの形式が正しくありません' });

  var sheet = getMembersSheet();
  var photoUrl = result.rowData[8]; // 既存の写真を維持

  if (body.photoBase64) {
    var photoResult = savePhotoToDrive(body.photoBase64, body.photoMimeType, session.userId);
    if (!photoResult.ok) return jsonResponse({ status: 'error', message: photoResult.message });
    deleteDrivePhotoByUrl(photoUrl); // 古い写真を削除
    photoUrl = photoResult.url;
  } else if (body.removePhoto === true) {
    deleteDrivePhotoByUrl(photoUrl);
    photoUrl = '';
  }

  sheet.getRange(result.rowIndex, 4).setValue(contact);   // D: contact
  sheet.getRange(result.rowIndex, 5).setValue(area);      // E: area
  sheet.getRange(result.rowIndex, 6).setValue(drink);     // F: drink
  sheet.getRange(result.rowIndex, 7).setValue(comment);   // G: comment
  sheet.getRange(result.rowIndex, 8).setValue(storeUrl);  // H: storeUrl
  sheet.getRange(result.rowIndex, 9).setValue(photoUrl);  // I: photoUrl

  return jsonResponse({ status: 'ok', message: '更新しました', photoUrl: photoUrl });
}

// ============================================================
// 投稿の削除（ログイン必須・自分の投稿のみ）
// ============================================================
function handleDelete(body) {
  var session = getSession(body.token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var result = findMemberRowById(body.rowId);
  if (!result.ok) return jsonResponse({ status: 'error', message: result.message });
  if (result.rowData[1] !== session.userId) {
    return jsonResponse({ status: 'error', message: '自分の投稿のみ削除できます' });
  }

  deleteDrivePhotoByUrl(result.rowData[8]);
  getMembersSheet().deleteRow(result.rowIndex);
  deleteReviewsByRowId(body.rowId);
  deleteRankingsByRowId(body.rowId);

  return jsonResponse({ status: 'ok', message: '削除しました' });
}

// ============================================================
// お気に入り
// ============================================================
function handleAddFavorite(body) {
  var session = getSession(body.token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var sheet = getFavoritesSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === session.userId && data[i][1] === body.rowId) {
      return jsonResponse({ status: 'ok' });
    }
  }
  sheet.appendRow([session.userId, body.rowId, new Date()]);
  return jsonResponse({ status: 'ok' });
}

function handleRemoveFavorite(body) {
  var session = getSession(body.token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var sheet = getFavoritesSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === session.userId && data[i][1] === body.rowId) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  return jsonResponse({ status: 'ok' });
}

function handleMyFavorites(token) {
  var session = getSession(token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var sheet = getFavoritesSheet();
  var data  = sheet.getDataRange().getValues();
  var rowIds = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === session.userId) rowIds.push(data[i][1]);
  }
  return jsonResponse({ status: 'ok', rowIds: rowIds });
}

// ============================================================
// レビュー（コメント＋5段階評価）
// 1会員1投稿につき1件まで。再送信で上書き更新。
// ============================================================
function handleSubmitReview(body) {
  var session = getSession(body.token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var rowId = body.rowId;
  var rating = Number(body.rating);
  var comment = sanitize(body.comment);

  if (!findMemberRowById(rowId).ok) return jsonResponse({ status: 'error', message: '対象の投稿が見つかりません' });
  if (!rating || rating < 1 || rating > 5 || rating % 1 !== 0) {
    return jsonResponse({ status: 'error', message: '評価は1〜5の整数で指定してください' });
  }
  if (comment.length > 200) return jsonResponse({ status: 'error', message: 'コメントが長すぎます（200文字まで）' });

  var user = findUserById(session.userId);
  var sheet = getReviewsSheet();
  var data = sheet.getDataRange().getValues();
  var now = new Date();

  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === rowId && data[i][2] === session.userId) {
      // 既存レビューを更新
      sheet.getRange(i + 1, 4).setValue(user.nickname); // D nickname（変更されている場合に同期）
      sheet.getRange(i + 1, 5).setValue(rating);         // E rating
      sheet.getRange(i + 1, 6).setValue(comment);        // F comment
      sheet.getRange(i + 1, 8).setValue(now);             // H updatedAt
      return jsonResponse({ status: 'ok', message: 'レビューを更新しました' });
    }
  }

  var reviewId = Utilities.getUuid();
  sheet.appendRow([reviewId, rowId, session.userId, user.nickname, rating, comment, now, now]);
  return jsonResponse({ status: 'ok', message: 'レビューを投稿しました' });
}

function handleDeleteReview(body) {
  var session = getSession(body.token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var sheet = getReviewsSheet();
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === body.reviewId) {
      if (data[i][2] !== session.userId) {
        return jsonResponse({ status: 'error', message: '自分のレビューのみ削除できます' });
      }
      sheet.deleteRow(i + 1);
      return jsonResponse({ status: 'ok', message: 'レビューを削除しました' });
    }
  }
  return jsonResponse({ status: 'error', message: 'レビューが見つかりません' });
}

function handleListReviews(rowId) {
  if (!rowId) return jsonResponse({ status: 'error', message: 'rowIdが必要です' });
  var sheet = getReviewsSheet();
  var data = sheet.getDataRange().getValues();
  var reviews = [];
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][1] === rowId) {
      reviews.push({
        reviewId: data[i][0], rowId: data[i][1], userId: data[i][2],
        nickname: data[i][3], rating: data[i][4], comment: data[i][5],
        createdAt: data[i][6] ? Utilities.formatDate(new Date(data[i][6]), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : ''
      });
    }
  }
  return jsonResponse({ status: 'ok', reviews: reviews });
}

// 全投稿の平均評価・件数をまとめて計算（一覧表示用）
function buildRatingMap() {
  var sheet = getReviewsSheet();
  var data = sheet.getDataRange().getValues();
  var map = {}; // rowId -> { sum, count }
  for (var i = 1; i < data.length; i++) {
    var rowId = data[i][1];
    var rating = Number(data[i][4]) || 0;
    if (!map[rowId]) map[rowId] = { sum: 0, count: 0 };
    map[rowId].sum += rating;
    map[rowId].count += 1;
  }
  return map;
}

// ============================================================
// おすすめベスト100（会員ごとに1〜100位のランキングを登録。
// 1位=100点、100位=1点（101-rank）として全会員分を合計し、
// その合計点をもとに偏差値を算出する）
// ============================================================

// ベスト100を丸ごと保存（既存分は全削除して作り直す＝洗い替え）
function handleSaveMyRanking(body) {
  var session = getSession(body.token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var rowIds = body.rowIds;
  if (!Array.isArray(rowIds)) return jsonResponse({ status: 'error', message: 'rowIdsが不正です' });
  if (rowIds.length > MAX_RANKING_ITEMS) {
    return jsonResponse({ status: 'error', message: 'ベスト' + MAX_RANKING_ITEMS + 'までしか登録できません' });
  }

  // 重複除去＋実在する投稿のみに絞る
  var seen = {};
  var validRowIds = [];
  rowIds.forEach(function(rowId) {
    if (seen[rowId]) return;
    seen[rowId] = true;
    if (findMemberRowById(rowId).ok) validRowIds.push(rowId);
  });

  var sheet = getRankingsSheet();
  var data = sheet.getDataRange().getValues();
  var now = new Date();

  // 既存の自分の行を全削除
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === session.userId) sheet.deleteRow(i + 1);
  }

  // 1位から順に書き込み（rank = 配列のインデックス+1）
  validRowIds.forEach(function(rowId, index) {
    sheet.appendRow([session.userId, rowId, index + 1, now]);
  });

  return jsonResponse({ status: 'ok', message: 'ベスト100を保存しました', count: validRowIds.length });
}

// 自分のベスト100を取得（rowId→rankの配列を、rank昇順で返す）
function handleMyRanking(token) {
  var session = getSession(token);
  if (!session) return jsonResponse({ status: 'error', message: 'ログインが必要です' });

  var sheet = getRankingsSheet();
  var data = sheet.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === session.userId) {
      items.push({ rowId: data[i][1], rank: Number(data[i][2]) });
    }
  }
  items.sort(function(a, b) { return a.rank - b.rank; });
  return jsonResponse({ status: 'ok', items: items });
}

// 全会員のランキングを集計し、投稿(rowId)ごとの合計点を算出
// score = Σ(101 - rank)  ※1位=100点、100位=1点
function buildRankingScoreMap() {
  var sheet = getRankingsSheet();
  var data = sheet.getDataRange().getValues();
  var map = {}; // rowId -> { score, voterCount }
  for (var i = 1; i < data.length; i++) {
    var rowId = data[i][1];
    var rank = Number(data[i][2]);
    if (!rank || rank < 1 || rank > MAX_RANKING_ITEMS) continue;
    var points = (MAX_RANKING_ITEMS + 1) - rank; // 1位=100点, 100位=1点
    if (!map[rowId]) map[rowId] = { score: 0, voterCount: 0 };
    map[rowId].score += points;
    map[rowId].voterCount += 1;
  }
  return map;
}

// 合計点の分布から偏差値（平均50・標準偏差10）を算出
// 母集団は「誰かのベスト100に1回以上ランクインした投稿」のみ
function buildHensachiMap() {
  var scoreMap = buildRankingScoreMap();
  var rowIds = Object.keys(scoreMap);
  if (rowIds.length === 0) return {};

  var scores = rowIds.map(function(id) { return scoreMap[id].score; });
  var mean = scores.reduce(function(a, b) { return a + b; }, 0) / scores.length;
  var variance = scores.reduce(function(a, b) { return a + Math.pow(b - mean, 2); }, 0) / scores.length;
  var stddev = Math.sqrt(variance);

  var result = {};
  rowIds.forEach(function(rowId) {
    var score = scoreMap[rowId].score;
    var hensachi = (stddev === 0) ? 50 : 50 + 10 * (score - mean) / stddev;
    result[rowId] = {
      score: score,
      voterCount: scoreMap[rowId].voterCount,
      hensachi: Math.round(hensachi * 10) / 10
    };
  });
  return result;
}

function deleteRankingsByUser(userId) {
  var sheet = getRankingsSheet();
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === userId) sheet.deleteRow(i + 1);
  }
}

function deleteRankingsByRowId(rowId) {
  var sheet = getRankingsSheet();
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][1] === rowId) sheet.deleteRow(i + 1);
  }
}

// ============================================================
// 管理者：一覧取得
// ============================================================
function handleAdminList(adminPassword) {
  if (!verifyAdminPassword(adminPassword)) {
    return jsonResponse({ status: 'error', message: '管理者パスワードが違います' });
  }
  return handleList();
}

// ============================================================
// 管理者：更新・削除
// ============================================================
function handleAdminUpdate(body) {
  if (!verifyAdminPassword(body.adminPassword)) {
    return jsonResponse({ status: 'error', message: '管理者パスワードが違います' });
  }
  var result = findMemberRowById(body.rowId);
  if (!result.ok) return jsonResponse({ status: 'error', message: result.message });

  var contact = sanitize(body.contact);
  var area    = sanitize(body.area);
  var drink   = sanitize(body.drink);
  var comment = sanitize(body.comment);
  var nickname = sanitize(body.nickname);
  var storeUrl = sanitizeUrl(body.storeUrl);

  if (!nickname || !area || !drink || !comment) {
    return jsonResponse({ status: 'error', message: '必須項目が不足しています' });
  }

  var sheet = getMembersSheet();
  sheet.getRange(result.rowIndex, 3).setValue(nickname);
  sheet.getRange(result.rowIndex, 4).setValue(contact);
  sheet.getRange(result.rowIndex, 5).setValue(area);
  sheet.getRange(result.rowIndex, 6).setValue(drink);
  sheet.getRange(result.rowIndex, 7).setValue(comment);
  sheet.getRange(result.rowIndex, 8).setValue(storeUrl);

  return jsonResponse({ status: 'ok', message: '更新しました' });
}

function handleAdminDelete(body) {
  if (!verifyAdminPassword(body.adminPassword)) {
    return jsonResponse({ status: 'error', message: '管理者パスワードが違います' });
  }
  var result = findMemberRowById(body.rowId);
  if (!result.ok) return jsonResponse({ status: 'error', message: result.message });

  deleteDrivePhotoByUrl(result.rowData[8]);
  getMembersSheet().deleteRow(result.rowIndex);
  deleteReviewsByRowId(body.rowId);
  deleteRankingsByRowId(body.rowId);

  return jsonResponse({ status: 'ok', message: '削除しました' });
}

// ============================================================
// セッション管理（CacheService）
// ============================================================
function createSession(userId) {
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('session_' + token, userId, SESSION_TTL_SEC);
  return token;
}

function getSession(token) {
  if (!token) return null;
  var userId = CacheService.getScriptCache().get('session_' + token);
  if (!userId) return null;
  return { userId: userId };
}

// ============================================================
// users シート ヘルパー
// ============================================================
function findUserByEmail(email) {
  var sheet = getUsersSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]).toLowerCase() === email && data[i][7] === 'active') {
      return rowToUser(data[i], i + 1);
    }
  }
  return null;
}

function findUserById(userId) {
  var sheet = getUsersSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(userId)) {
      return rowToUser(data[i], i + 1);
    }
  }
  return null;
}

function rowToUser(row, rowIndex) {
  return {
    rowIndex: rowIndex,
    userId: row[0], email: row[1], passwordHash: row[2], salt: row[3],
    nickname: row[4], isTempPassword: row[5], agreedTermsAt: row[6],
    status: row[7], createdAt: row[8]
  };
}

function updateUserRow(rowIndex, fields) {
  var sheet = getUsersSheet();
  var colMap = { email: 2, passwordHash: 3, salt: 4, nickname: 5, isTempPassword: 6, status: 8 };
  Object.keys(fields).forEach(function(key) {
    if (colMap[key]) sheet.getRange(rowIndex, colMap[key]).setValue(fields[key]);
  });
}

// ============================================================
// members シート ヘルパー
// ============================================================
function findMemberRowById(rowId) {
  var sheet = getMembersSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(rowId)) {
      return { ok: true, rowIndex: i + 1, rowData: data[i] };
    }
  }
  return { ok: false, message: '投稿が見つかりません' };
}

function rowToMember(row, ratingMap, hensachiMap) {
  var rowId = String(row[0]);
  var stats = (ratingMap && ratingMap[rowId]) ? ratingMap[rowId] : null;
  var avgRating = stats ? Math.round((stats.sum / stats.count) * 10) / 10 : null;
  var reviewCount = stats ? stats.count : 0;

  var rankStats = (hensachiMap && hensachiMap[rowId]) ? hensachiMap[rowId] : null;

  return {
    rowId:     rowId,
    userId:    String(row[1]),
    nickname:  String(row[2]),
    contact:   String(row[3]),
    area:      String(row[4]),
    drink:     String(row[5]),
    comment:   String(row[6]),
    storeUrl:  String(row[7] || ''),
    photoUrl:  String(row[8] || ''),
    date:      row[9] ? Utilities.formatDate(new Date(row[9]), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : '',
    avgRating: avgRating,
    reviewCount: reviewCount,
    rankScore: rankStats ? rankStats.score : null,     // ベスト100集計点（1位=100点〜100位=1点の合計）
    rankVoterCount: rankStats ? rankStats.voterCount : 0, // 何人のベスト100にランクインしているか
    hensachi:  rankStats ? rankStats.hensachi : null   // ランキング得点を基準にした偏差値
  };
}

function deleteMembersByUser(userId) {
  var sheet = getMembersSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][1] === userId) sheet.deleteRow(i + 1);
  }
}

function deletePhotosForUserPosts(userId) {
  var sheet = getMembersSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === userId && data[i][8]) deleteDrivePhotoByUrl(data[i][8]);
  }
}

function syncNicknameToMembers(userId, nickname) {
  var sheet = getMembersSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === userId) sheet.getRange(i + 1, 3).setValue(nickname);
  }
}

function syncNicknameToReviews(userId, nickname) {
  var sheet = getReviewsSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][2] === userId) sheet.getRange(i + 1, 4).setValue(nickname);
  }
}

// ============================================================
// favorites シート ヘルパー
// ============================================================
function deleteFavoritesByUser(userId) {
  var sheet = getFavoritesSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === userId) sheet.deleteRow(i + 1);
  }
}

// ============================================================
// reviews シート ヘルパー
// ============================================================
function deleteReviewsByUser(userId) {
  var sheet = getReviewsSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][2] === userId) sheet.deleteRow(i + 1);
  }
}

function deleteReviewsByRowId(rowId) {
  var sheet = getReviewsSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][1] === rowId) sheet.deleteRow(i + 1);
  }
}

// ============================================================
// Googleドライブ写真アップロード
// ※フロント側でリサイズ済みのJPEG(base64)を受け取る前提
// ============================================================
function savePhotoToDrive(base64Data, mimeType, userId) {
  try {
    var cleanBase64 = base64Data.indexOf(',') >= 0 ? base64Data.split(',')[1] : base64Data;
    var bytes = Utilities.base64Decode(cleanBase64);

    if (bytes.length > MAX_PHOTO_BYTES) {
      return { ok: false, message: '写真のサイズが大きすぎます（4MBまで）' };
    }

    var type = mimeType || 'image/jpeg';
    var ext  = type.indexOf('png') >= 0 ? 'png' : 'jpg';
    var filename = 'oishii-ippai_' + userId + '_' + new Date().getTime() + '.' + ext;

    var blob = Utilities.newBlob(bytes, type, filename);
    var folder = getPhotoFolder();
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    var url = 'https://drive.google.com/uc?export=view&id=' + file.getId();
    return { ok: true, url: url, fileId: file.getId() };
  } catch (err) {
    return { ok: false, message: '写真のアップロードに失敗しました: ' + err.message };
  }
}

function deleteDrivePhotoByUrl(photoUrl) {
  if (!photoUrl) return;
  var match = String(photoUrl).match(/id=([a-zA-Z0-9_-]+)/);
  if (!match) return;
  try {
    var file = DriveApp.getFileById(match[1]);
    file.setTrashed(true);
  } catch (err) {
    Logger.log('deleteDrivePhotoByUrl failed: ' + err.message);
  }
}

function getPhotoFolder() {
  if (PHOTO_FOLDER_ID) {
    return DriveApp.getFolderById(PHOTO_FOLDER_ID);
  }
  var folders = DriveApp.getFoldersByName('oishii-ippai-photos');
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder('oishii-ippai-photos');
}

// ============================================================
// シート取得（なければ作成）
// ============================================================
function getUsersSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_USERS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_USERS);
    sheet.appendRow(['userId','email','passwordHash','salt','nickname','isTempPassword','agreedTermsAt','status','createdAt']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getMembersSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_MEMBERS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_MEMBERS);
    sheet.appendRow(['rowId','userId','nickname','contact','area','drink','comment','storeUrl','photoUrl','date']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getFavoritesSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_FAVORITES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_FAVORITES);
    sheet.appendRow(['userId','rowId','createdAt']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getReviewsSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_REVIEWS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_REVIEWS);
    sheet.appendRow(['reviewId','rowId','userId','nickname','rating','comment','createdAt','updatedAt']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getRankingsSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_RANKINGS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_RANKINGS);
    sheet.appendRow(['userId','rowId','rank','updatedAt']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ============================================================
// 管理者パスワード検証
// ============================================================
function verifyAdminPassword(adminPassword) {
  if (!adminPassword) return false;
  return simpleHash(adminPassword) === simpleHash(ADMIN_PASSWORD);
}

// ============================================================
// パスワードハッシュ（会員用：SHA-256 + salt + pepper + ストレッチ）
// ============================================================
function hashPassword(password, salt) {
  var value = password + salt + PEPPER;
  for (var i = 0; i < PBKDF_ITERATIONS; i++) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
    value = bytesToHex(bytes);
  }
  return value;
}

function simpleHash(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytesToHex(bytes);
}

function bytesToHex(bytes) {
  return bytes.map(function(b) {
    var hex = (b < 0 ? b + 256 : b).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

function generateTempPassword() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var out = '';
  for (var i = 0; i < 8; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ============================================================
// 共通ユーティリティ
// ============================================================
function jsonResponse(obj) {
  var output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function sanitize(str) {
  if (!str) return '';
  return String(str).trim()
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeUrl(str) {
  if (!str) return '';
  var trimmed = String(str).trim();
  if (!trimmed) return '';
  if (!/^https?:\/\/[^\s<>"']+$/i.test(trimmed)) return null;
  return trimmed;
}

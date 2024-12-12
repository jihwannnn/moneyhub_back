const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { onDocumentCreated } = require("firebase-functions/v2/firestore");

admin.initializeApp();

exports.onTransactionCreated = onDocumentCreated('transactions_group/{gid}/transactions/{tid}', async (event) => {
    const transaction = event.data.data();
    const gid = transaction.gid;
    console.log('Transaction:', JSON.stringify(transaction, null, 2));

    try {
        // 1. 그룹의 모든 멤버 가져오기
        const membersSnapshot = await admin.firestore()
            .collection('members_group')
            .doc(gid)
            .collection('members')
            .get();

        const members = membersSnapshot.docs.map(doc => doc.data());
        console.log('Members:', JSON.stringify(members, null, 2));


        // 2. 작성자를 제외한 각 멤버에게 알림 전송
        const notifications = members
            .filter(member => member.uid !== transaction.authorId)
            .map(async member => {

                console.log('Processing notification for member:', member.uid);
                // 2-1. Firestore에 알림 데이터 저장
                const notificationRef = admin.firestore()
                    .collection('notifications')
                    .doc();

                const notification = {
                    nid: notificationRef.id,
                    gid: transaction.gid,
                    title: '새로운 거래내역',
                    content: `${transaction.authorName}님이 ${transaction.amount}원의 ${transaction.type ? '수입' : '지출'}을(를) 등록했습니다.`,
                    type: 'TRANSACTION_ADDED',
                    recipientId: member.uid,
                    data: {
                        transactionId: transaction.tid,
                        groupId: transaction.gid
                    },
                    read: false,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                };

                console.log('Notification to be saved:', JSON.stringify(notification, null, 2));

                await notificationRef.set(notification);

                // 2-2. 사용자의 FCM 토큰 가져오기
                const tokenDoc = await admin.firestore()
                    .collection('fcm_tokens')
                    .doc(member.uid)
                    .get();

                const fcmToken = tokenDoc.get('token');
                if (!fcmToken) return;
                console.log('FCM Token for member:', member.uid, ':', fcmToken);

                // 2-3. FCM 메시지 전송
                const message = {
                    token: fcmToken,
                    notification: {
                        title: notification.title,
                        body: notification.content
                    },
                    data: {
                        type: notification.type,
                        transactionId: transaction.tid,
                        groupId: transaction.gid
                    },
                    android: {
                        notification: {
                            channelId: 'transaction_notification'
                        }
                    }
                };

                return admin.messaging().send(message);
            });

        await Promise.all(notifications);

    } catch (error) {
        console.error('Error sending notifications:', error);
    }
});

// FCM 토큰 업데이트 함수
exports.updateFcmToken = functions.https.onCall(async (request) => {
    
    if (!request.auth) {
        throw new functions.https.HttpsError(
            'unauthenticated',
            '인증이 필요한 작업입니다.'
        );
    }

    const { token } = request.data;
    const userId = request.auth.uid;

    try {
        await admin.firestore()
            .collection('fcm_tokens')
            .doc(userId)
            .set({
                userId,
                token,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

        return { success: true };
    } catch (error) {
        console.error('Error updating FCM token:', error);
        throw new functions.https.HttpsError(
            'internal',
            'FCM 토큰 업데이트에 실패했습니다.'
        );
    }
});
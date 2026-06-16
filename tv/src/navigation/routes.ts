export type RootStackParamList = {
  Login: undefined;
  Home: undefined;
  Detail: { itemId: string };
  Player: { itemId: string; startSeconds?: number };
  Settings: undefined;
};

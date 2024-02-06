export const typeDefs = `
enum YesNo {
  YES
  NO
}

type Address {
  street: String!
  city: String!
}

type Person {
  name: String!
  phone: String
  address: Address!
  id: ID!
}

type User {
  username: String!
  friends: [Person]!
  id: ID!
}

type Token {
  value: String!
}

type PersonREST {
  name: String!
  id: ID!
  email: String!
}

type Query {
  personCount: Int!
  allPersons(phone: YesNo): [Person]!
  findPerson(name: String!): Person
  allPersonsREST: [PersonREST]!
  me: User
}

type Mutation {
  addPerson(
    name: String!
    phone: String
    street: String!
    city: String!
  ): Person
  editNumber(name: String!, phone: String!): Person
  createUser(username: String!): User
  login(username: String!, password: String!): Token
  addAsFriend(name: String!): User
}

type Subscription {
  personAdded: Person!
}
`;

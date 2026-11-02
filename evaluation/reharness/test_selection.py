import unittest
import selection_score

class SelectionTests(unittest.TestCase):
    def test_counts_missed_and_unnecessary_revision_and_uncertainty(self):
        labels={'task':{'a':True,'b':False,'c':True,'d':False}}
        rows={'task':[{'memory_id':'a','action':'keep'},{'memory_id':'b','action':'revise'},
                      {'memory_id':'c','action':'uncertain'},{'memory_id':'d','action':'keep'}]}
        actual=selection_score.score(labels,rows)
        self.assertEqual((actual['true_positive'],actual['false_positive'],actual['false_negative'],actual['true_negative']),(1,1,1,1))
        self.assertEqual(actual['uncertain'],1)
        self.assertEqual(actual['recall'],0.5)
        self.assertEqual(actual['precision'],0.5)
    def test_rejects_incomplete_unknown_duplicate_and_invalid_labels(self):
        labels={'t':{'a':True}}
        for rows in ({}, {'t':[]},{'t':[{'memory_id':'x','action':'keep'}]},
                     {'t':[{'memory_id':'a','action':'keep'}]*2},
                     {'t':[{'memory_id':'a','action':'maybe'}]}):
            with self.assertRaises(ValueError):selection_score.score(labels,rows)
        with self.assertRaises(ValueError):selection_score.score({'t':{'a':'true'}},{'t':[{'memory_id':'a','action':'keep'}]})
